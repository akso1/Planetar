import {
  createClient,
  IndexedDBStore,
  MatrixClient,
  SetPresence,
  SyncState,
  type ILoginFlowsResponse,
  type IIdentityProvider,
} from "matrix-js-sdk";
import { MemoryStore } from "matrix-js-sdk/lib/store/memory";
import type { CryptoCallbacks } from "matrix-js-sdk/lib/crypto-api";
import type { IStore } from "matrix-js-sdk/lib/store";

const SESSION_KEY = "matrix-session-credentials";
const SSO_PENDING_BASEURL_KEY = "matrix-sso-pending-baseurl";
const CRYPTO_PREFIX_KEY = "matrix-crypto-store-prefix";
/** Default prefix used by matrix-js-sdk when none is provided */
const DEFAULT_CRYPTO_PREFIX = "matrix-js-sdk";
/** How many recent timeline events to pull on a cold (no-cache) first sync */
const INITIAL_SYNC_LIMIT = 20;

/** Redirect target Matrix HS will hit after IdP login (intercepted by Electron). */
export const SSO_REDIRECT_URL = "http://localhost/matrix-sso-callback";

interface StoredCredentials {
  baseUrl: string;
  userId: string;
  accessToken: string;
  deviceId?: string;
}

/** Ensure homeserver has a scheme so `new URL()` / SDK clients do not throw Invalid URL. */
export function normalizeHomeserverUrl(homeserver: string): string {
  const trimmed = homeserver.trim().replace(/\/$/, '');
  if (!trimmed) return trimmed;
  const cleanHomeserver = trimmed.startsWith('http')
    ? trimmed
    : `https://${trimmed}`;
  return cleanHomeserver.replace(/\/$/, '');
}

function cryptoStorePrefixFor(userId: string, deviceId: string): string {
  // IndexedDB-safe, unique per account+device so re-login never clashes
  const safe = `${userId}__${deviceId}`.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `matrix-js-sdk-${safe}`;
}

function roomStoreDbName(userId: string): string {
  const safe = userId.replace(/[^a-zA-Z0-9._-]/g, "_");
  return `matrix-macos-client-rooms-${safe}`;
}

async function deleteIndexedDb(dbname: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  await new Promise<void>((resolve) => {
    try {
      const req = indexedDB.deleteDatabase(dbname);
      // Give blocked deletes a moment — common after HMR / double-start.
      const done = () => resolve();
      req.onsuccess = done;
      req.onerror = done;
      req.onblocked = () => {
        window.setTimeout(done, 250);
      };
    } catch {
      resolve();
    }
  });
}

async function deleteCryptoIndexedDbs(prefix: string): Promise<void> {
  const names = [
    `${prefix}::matrix-sdk-crypto`,
    `${prefix}::matrix-sdk-crypto-meta`,
  ];
  for (const dbname of names) {
    await deleteIndexedDb(dbname);
  }
}

function errorMessage(err: unknown): string {
  if (err instanceof Error) return err.message;
  if (typeof err === "object" && err && "message" in err) {
    return String((err as { message: unknown }).message);
  }
  return String(err);
}

function withTimeout<T>(
  promise: Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = window.setTimeout(() => {
      reject(new Error(`${label} timed out after ${ms}ms`));
    }, ms);
    promise.then(
      (value) => {
        window.clearTimeout(timer);
        resolve(value);
      },
      (err) => {
        window.clearTimeout(timer);
        reject(err);
      },
    );
  });
}

function isCryptoAccountMismatch(err: unknown): boolean {
  const msg = errorMessage(err);
  return (
    msg.includes("doesn't match the account") ||
    msg.includes("account in the store doesn't match")
  );
}

/** Chromium/Electron LevelDB backing-store corruption / open failures. */
function isIndexedDbHardFailure(err: unknown): boolean {
  const msg = errorMessage(err);
  const name =
    typeof err === "object" && err && "name" in err
      ? String((err as { name: unknown }).name)
      : "";
  return (
    name === "UnknownError" ||
    msg.includes("UnknownError") ||
    msg.includes("Internal error opening backing store") ||
    msg.includes("backing store") ||
    msg.includes("reading 'transaction'") ||
    msg.includes("timed out after") ||
    (msg.includes("IndexedDB") && msg.includes("failed"))
  );
}

/** Cap how long we wait on a stuck IndexedDB open before wipe/fallback. */
const CRYPTO_IDB_TIMEOUT_MS = 6_000;
const ROOM_STORE_IDB_TIMEOUT_MS = 5_000;

class MatrixService {
  private static instance: MatrixService;
  public client: MatrixClient | null = null;
  private roomStore: IStore | null = null;
  private startupPromise: Promise<boolean> | null = null;
  /** Single-flight for initRustCrypto — parallel callers await the same promise. */
  private cryptoReadyPromise: Promise<void> | null = null;

  private cachedSecretStorageKey: {
    keyId: string;
    privateKey: Uint8Array<ArrayBuffer>;
  } | null = null;

  private readonly cryptoCallbacks: CryptoCallbacks = {
    getSecretStorageKey: async ({ keys }) => {
      const cached = this.cachedSecretStorageKey;
      if (!cached) return null;

      // Only exact keyId match — never pair cached material with a different id
      // (would unlock the wrong secret-storage key / corrupt restore).
      if (!(cached.keyId in keys)) {
        console.warn(
          "[crypto] cached secret storage keyId not in requested keys — clearing cache",
        );
        this.cachedSecretStorageKey = null;
        void this.clearPersistedSecretStorageKey();
        return null;
      }

      return [cached.keyId, cached.privateKey];
    },
  };

  private constructor() {}

  public static getInstance(): MatrixService {
    if (!MatrixService.instance) {
      MatrixService.instance = new MatrixService();
    }
    return MatrixService.instance;
  }

  public cacheSecretStorageKey(
    keyId: string,
    privateKey: Uint8Array<ArrayBuffer>
  ): void {
    this.cachedSecretStorageKey = { keyId, privateKey };
    void this.persistSecretStorageKey(keyId, privateKey);
  }

  public clearCachedSecretStorageKey(): void {
    this.cachedSecretStorageKey = null;
    void this.clearPersistedSecretStorageKey();
  }

  /**
   * Load a previously unlocked recovery key from Electron safeStorage and
   * restore the Megolm backup so encrypted history decrypts after restart.
   */
  public async hydrateSecretStorageFromDisk(): Promise<boolean> {
    if (this.cachedSecretStorageKey) return true;
    const client = this.client;
    if (!client) return false;
    const userId = client.getUserId();
    const deviceId = client.getDeviceId();
    if (!userId || !deviceId) return false;

    const api = window.electronAPI;
    if (!api?.getSecretStorageKey) return false;

    let stored: {
      keyId: string;
      privateKeyBase64: string;
    } | null = null;
    try {
      stored = await api.getSecretStorageKey({ userId, deviceId });
    } catch (err) {
      console.warn("Persisted secret storage key read failed:", err);
      return false;
    }
    if (!stored?.keyId || !stored.privateKeyBase64) return false;

    try {
      const privateKey = base64ToUint8Array(stored.privateKeyBase64);
      this.cachedSecretStorageKey = {
        keyId: stored.keyId,
        privateKey,
      };

      const crypto = client.getCrypto();
      if (!crypto) return true;

      // Verify the key still matches account secret storage before restore.
      const keyTuple = await client.secretStorage.getKey();
      if (keyTuple) {
        const [, keyInfo] = keyTuple;
        const matches = await client.secretStorage.checkKey(privateKey, keyInfo);
        if (!matches) {
          console.warn(
            "Persisted secret storage key no longer matches — clearing.",
          );
          this.cachedSecretStorageKey = null;
          await this.clearPersistedSecretStorageKey();
          return false;
        }
      }

      await crypto.loadSessionBackupPrivateKeyFromSecretStorage();
      await crypto.restoreKeyBackup();
      return true;
    } catch (err) {
      console.warn("Failed to hydrate secret storage / key backup:", err);
      this.cachedSecretStorageKey = null;
      return false;
    }
  }

  private async persistSecretStorageKey(
    keyId: string,
    privateKey: Uint8Array<ArrayBuffer>,
  ): Promise<void> {
    const client = this.client;
    const userId = client?.getUserId();
    const deviceId = client?.getDeviceId();
    const api = window.electronAPI;
    if (!api?.setSecretStorageKey || !userId || !deviceId) return;

    try {
      await api.setSecretStorageKey({
        userId,
        deviceId,
        keyId,
        privateKeyBase64: uint8ArrayToBase64(privateKey),
      });
    } catch (err) {
      console.warn("Persisted secret storage key write failed:", err);
    }
  }

  private async clearPersistedSecretStorageKey(): Promise<void> {
    const api = window.electronAPI;
    if (!api?.clearSecretStorageKey) return;
    const userId = this.client?.getUserId();
    const deviceId = this.client?.getDeviceId();
    try {
      if (userId && deviceId) {
        await api.clearSecretStorageKey({ userId, deviceId });
      } else {
        await api.clearSecretStorageKey();
      }
    } catch (err) {
      console.warn("Persisted secret storage key clear failed:", err);
    }
  }

  public async startup(): Promise<boolean> {
    // Deduplicate concurrent startups (React StrictMode / HMR)
    if (this.startupPromise) return this.startupPromise;

    this.startupPromise = this.doStartup().finally(() => {
      this.startupPromise = null;
    });
    return this.startupPromise;
  }

  private async doStartup(): Promise<boolean> {
    const creds = await this.getStoredCredentials();
    if (!creds?.deviceId) return false;

    // Reuse an already-running client with the same session
    if (
      this.client &&
      this.client.getUserId() === creds.userId &&
      this.client.getDeviceId() === creds.deviceId &&
      this.client.getAccessToken() === creds.accessToken
    ) {
      if (!this.client.getCrypto()) {
        try {
          await this.ensureCryptoReady();
          await this.hydrateSecretStorageFromDisk();
        } catch (e) {
          console.error("Rust crypto init failed on resume:", e);
        }
      } else {
        try {
          await this.hydrateSecretStorageFromDisk();
        } catch (e) {
          console.warn("Secret storage hydrate failed on resume:", e);
        }
      }
      return true;
    }

    await this.initializeClient(
      creds.baseUrl,
      creds.userId,
      creds.accessToken,
      creds.deviceId
    );
    await this.start();
    return true;
  }

  public async login(
    baseUrl: string,
    userId: string,
    password: string
  ): Promise<MatrixClient> {
    const cleanHomeserver = normalizeHomeserverUrl(baseUrl);
    const tempClient = createClient({ baseUrl: cleanHomeserver });
    const loginData = await tempClient.loginWithPassword(userId, password);

    await this.storeCredentials({
      baseUrl: cleanHomeserver,
      userId: loginData.user_id,
      accessToken: loginData.access_token,
      deviceId: loginData.device_id,
    });

    await this.initializeClient(
      cleanHomeserver,
      loginData.user_id,
      loginData.access_token,
      loginData.device_id
    );
    await this.start();

    return this.client!;
  }

  /** Complete SSO: exchange loginToken for credentials and start the client. */
  public async loginWithToken(
    baseUrl: string,
    loginToken: string
  ): Promise<MatrixClient> {
    const cleanHomeserver = normalizeHomeserverUrl(baseUrl);
    const tempClient = createClient({ baseUrl: cleanHomeserver });
    const loginData = await tempClient.loginRequest({
      type: "m.login.token",
      token: loginToken,
    });

    await this.storeCredentials({
      baseUrl: cleanHomeserver,
      userId: loginData.user_id,
      accessToken: loginData.access_token,
      deviceId: loginData.device_id,
    });
    sessionStorage.removeItem(SSO_PENDING_BASEURL_KEY);

    await this.initializeClient(
      cleanHomeserver,
      loginData.user_id,
      loginData.access_token,
      loginData.device_id
    );
    await this.start();

    return this.client!;
  }

  public async getLoginFlows(baseUrl: string): Promise<ILoginFlowsResponse> {
    const cleanHomeserver = normalizeHomeserverUrl(baseUrl);
    const tempClient = createClient({ baseUrl: cleanHomeserver });
    return tempClient.loginFlows();
  }

  public getSsoLoginUrl(baseUrl: string, idpId?: string): string {
    const cleanHomeserver = normalizeHomeserverUrl(baseUrl);
    const tempClient = createClient({ baseUrl: cleanHomeserver });
    return tempClient.getSsoLoginUrl(SSO_REDIRECT_URL, "sso", idpId);
  }

  public rememberSsoBaseUrl(baseUrl: string): void {
    sessionStorage.setItem(
      SSO_PENDING_BASEURL_KEY,
      normalizeHomeserverUrl(baseUrl),
    );
  }

  public getPendingSsoBaseUrl(): string | null {
    return sessionStorage.getItem(SSO_PENDING_BASEURL_KEY);
  }

  public pickPreferredIdp(
    flows: ILoginFlowsResponse
  ): IIdentityProvider | undefined {
    const ssoFlow = flows.flows.find(
      (f) => f.type === "m.login.sso" || f.type === "m.login.cas"
    ) as { identity_providers?: IIdentityProvider[] } | undefined;

    const providers = ssoFlow?.identity_providers ?? [];
    if (providers.length === 0) return undefined;

    const google = providers.find(
      (p) =>
        p.brand === "google" ||
        p.id.toLowerCase().includes("google") ||
        p.name.toLowerCase().includes("google")
    );
    return google ?? providers[0];
  }

  public hasSsoFlow(flows: ILoginFlowsResponse): boolean {
    return flows.flows.some(
      (f) => f.type === "m.login.sso" || f.type === "m.login.cas"
    );
  }

  /**
   * Open a room store: IndexedDB with wipe+retry on corruption, else MemoryStore.
   * Never returns a half-open IndexedDBStore (that caused transaction-on-undefined crashes).
   */
  private async openRoomStore(userId: string): Promise<IStore> {
    const dbName = roomStoreDbName(userId);

    for (let attempt = 0; attempt < 2; attempt++) {
      const store = new IndexedDBStore({
        indexedDB: globalThis.indexedDB,
        localStorage: globalThis.localStorage,
        dbName,
      });
      try {
        await withTimeout(
          store.startup(),
          ROOM_STORE_IDB_TIMEOUT_MS,
          "Room IndexedDBStore.startup",
        );
        return store;
      } catch (err) {
        console.warn(
          `Room IndexedDBStore startup failed (attempt ${attempt + 1}):`,
          err,
        );
        try {
          await store.destroy();
        } catch {
          /* ignore */
        }
        await deleteIndexedDb(dbName);
      }
    }

    console.warn(
      "Room store: IndexedDB unavailable — using MemoryStore (cold sync this session)",
    );
    return new MemoryStore({ localStorage: globalThis.localStorage });
  }

  private async initializeClient(
    baseUrl: string,
    userId: string,
    accessToken: string,
    deviceId?: string
  ) {
    if (this.client) {
      this.client.stopClient();
    }
    if (this.roomStore) {
      try {
        await this.roomStore.destroy();
      } catch (err) {
        console.warn("Failed to destroy previous room store", err);
      }
      this.roomStore = null;
    }

    this.roomStore = await this.openRoomStore(userId);

    this.client = createClient({
      baseUrl,
      userId,
      accessToken,
      deviceId,
      store: this.roomStore,
      disableVoip: false,
      // Needed for TimelineWindow jumps (profile media → message in chat)
      timelineSupport: true,
      threadSupport: true,
      cryptoCallbacks: this.cryptoCallbacks,
    });
  }

  public listenToSync(
    onSync: (
      state: SyncState,
      prevState: SyncState | null,
      data?: any
    ) => void
  ) {
    this.client?.on("sync", onSync);
  }

  /**
   * Ensure Rust crypto is initialised. Safe to call multiple times.
   * Recovers from device-mismatch and corrupt IndexedDB; last resort is in-memory crypto.
   * Concurrent callers share one in-flight promise (avoids racing initRustCrypto on IndexedDB).
   */
  public async ensureCryptoReady(): Promise<void> {
    if (!this.client) {
      throw new Error("Matrix client is not initialised.");
    }
    if (this.client.getCrypto()) return;

    if (this.cryptoReadyPromise) {
      return this.cryptoReadyPromise;
    }

    this.cryptoReadyPromise = this.doEnsureCryptoReady().finally(() => {
      this.cryptoReadyPromise = null;
    });
    return this.cryptoReadyPromise;
  }

  private async doEnsureCryptoReady(): Promise<void> {
    if (!this.client) {
      throw new Error("Matrix client is not initialised.");
    }
    // Another waiter may have finished while we were queued
    if (this.client.getCrypto()) return;

    const deviceId = this.client.getDeviceId();
    const userId = this.client.getUserId();
    if (!deviceId || !userId) {
      throw new Error(
        "Cannot enable encryption: missing userId or deviceId. Please sign in again.",
      );
    }

    const prefix = cryptoStorePrefixFor(userId, deviceId);
    localStorage.setItem(CRYPTO_PREFIX_KEY, prefix);

    const initIndexed = () =>
      withTimeout(
        this.client!.initRustCrypto({
          useIndexedDB: true,
          cryptoDatabasePrefix: prefix,
        }),
        CRYPTO_IDB_TIMEOUT_MS,
        "Rust crypto IndexedDB",
      );

    const wipeCryptoDbs = async () => {
      await deleteCryptoIndexedDbs(prefix);
      await deleteCryptoIndexedDbs(DEFAULT_CRYPTO_PREFIX);
    };

    try {
      await initIndexed();
    } catch (err) {
      if (!isCryptoAccountMismatch(err) && !isIndexedDbHardFailure(err)) {
        throw err;
      }

      console.warn(
        "Crypto store open/mismatch — wiping IndexedDB and retrying:",
        err,
      );
      await wipeCryptoDbs();
      try {
        await initIndexed();
      } catch (err2) {
        console.warn(
          "Crypto IndexedDB still failing — falling back to in-memory crypto:",
          err2,
        );
        await wipeCryptoDbs();
        await withTimeout(
          this.client!.initRustCrypto({ useIndexedDB: false }),
          CRYPTO_IDB_TIMEOUT_MS,
          "Rust crypto memory",
        );
      }
    }

    if (!this.client.getCrypto()) {
      throw new Error("Failed to initialise end-to-end encryption.");
    }
  }

  public async start() {
    if (!this.client) return;

    // Crypto before sync so E2EE events decrypt as they arrive.
    // Room list can already be warm from IndexedDBStore.startup().
    try {
      await this.ensureCryptoReady();
    } catch (e) {
      console.error("Rust crypto init failed:", e);
      // Still start the client so the UI works for non-encrypted rooms,
      // but encrypted sends will call ensureCryptoReady again and surface the error.
    }

    // Don't block first sync on key-backup restore — hydrate in parallel.
    const hydrateP = this.hydrateSecretStorageFromDisk().catch((err) => {
      console.warn("Secret storage hydrate failed:", err);
      return false;
    });

    await this.client.startClient({ initialSyncLimit: INITIAL_SYNC_LIMIT });
    // Advertise online so peers can see us (and we get presence back in sync).
    void this.client.setSyncPresence(SetPresence.Online).catch(() => {});
    void this.client.setPresence({ presence: "online" }).catch(() => {});
    void hydrateP;
  }

  public stop() {
    this.client?.stopClient();
  }

  public async logout(): Promise<void> {
    const client = this.client;
    const userId = client?.getUserId() ?? null;
    const deviceId = client?.getDeviceId() ?? null;
    const prefix =
      localStorage.getItem(CRYPTO_PREFIX_KEY) ||
      (userId && deviceId ? cryptoStorePrefixFor(userId, deviceId) : null);

    // Drop recovery key from memory + disk before tearing down the client.
    this.cachedSecretStorageKey = null;
    this.cryptoReadyPromise = null;
    try {
      const api = window.electronAPI;
      if (api?.clearSecretStorageKey) {
        if (userId && deviceId) {
          await api.clearSecretStorageKey({ userId, deviceId });
        } else {
          await api.clearSecretStorageKey();
        }
      }
    } catch (err) {
      console.warn("Persisted secret storage key clear on logout failed:", err);
    }

    this.client = null;
    const roomStore = this.roomStore;
    this.roomStore = null;
    try {
      if (client) {
        try {
          await client.logout(true);
        } catch (err) {
          console.warn("Server logout failed:", err);
        }
        try {
          client.stopClient();
        } catch {
          /* ignore */
        }
        // clearStores requires client not running
        try {
          await client.clearStores({
            cryptoDatabasePrefix: prefix ?? DEFAULT_CRYPTO_PREFIX,
          });
        } catch (err) {
          console.warn("clearStores failed:", err);
        }
      }
      try {
        await roomStore?.destroy();
      } catch (err) {
        console.warn("Room store destroy failed:", err);
      }
    } catch (err) {
      console.warn("Logout cleanup error:", err);
    }

    // Always scrub known crypto DBs (current + legacy default)
    if (prefix) await deleteCryptoIndexedDbs(prefix);
    await deleteCryptoIndexedDbs(DEFAULT_CRYPTO_PREFIX);
    if (userId) await deleteIndexedDb(roomStoreDbName(userId));

    // Remove only our keys — never wipe the entire localStorage
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(CRYPTO_PREFIX_KEY);
    localStorage.removeItem(SSO_PENDING_BASEURL_KEY);
    try {
      sessionStorage.removeItem(SSO_PENDING_BASEURL_KEY);
    } catch {
      /* ignore */
    }

    try {
      await window.electronAPI?.clearSessionCredentials?.();
    } catch (err) {
      console.warn("clearSessionCredentials failed:", err);
    }
  }

  private parseStoredCredentials(raw: string | null): StoredCredentials | null {
    if (!raw) return null;
    try {
      const creds = JSON.parse(raw) as StoredCredentials;
      if (
        creds.baseUrl &&
        creds.userId &&
        creds.accessToken &&
        creds.deviceId
      ) {
        return creds;
      }
      return null;
    } catch {
      return null;
    }
  }

  private async getStoredCredentials(): Promise<StoredCredentials | null> {
    const api = window.electronAPI;

    // Attack prevented: never treat localStorage as a durable token vault
    const scrubPlaintextLocal = () => {
      try {
        localStorage.removeItem(SESSION_KEY);
      } catch {
        /* ignore */
      }
    };

    if (api?.getSessionCredentials) {
      try {
        const fromKeychain = await api.getSessionCredentials();
        if (
          fromKeychain?.baseUrl &&
          fromKeychain.userId &&
          fromKeychain.accessToken &&
          fromKeychain.deviceId
        ) {
          scrubPlaintextLocal();
          return fromKeychain as StoredCredentials;
        }
      } catch (err) {
        console.warn("Keychain session read failed:", err);
      }

      // One-time migration: legacy plaintext localStorage → OS-encrypted store only
      const legacy = this.parseStoredCredentials(
        localStorage.getItem(SESSION_KEY),
      );
      scrubPlaintextLocal();
      if (legacy) {
        try {
          const result = await api.setSessionCredentials?.(legacy);
          if (result && "ok" in result && result.ok === false) {
            // Fail closed: cannot re-encrypt → require fresh login (do not keep plaintext)
            console.warn(
              "Legacy session migrate failed (safeStorage) — forcing re-auth:",
              result.reason,
            );
            return null;
          }
          return legacy;
        } catch (err) {
          console.warn("Keychain session migrate failed — forcing re-auth:", err);
          return null;
        }
      }
      return null;
    }

    // No Electron secure IPC (e.g. unexpected environment): never fall back to localStorage tokens
    scrubPlaintextLocal();
    return null;
  }

  private async storeCredentials(creds: StoredCredentials): Promise<void> {
    const api = window.electronAPI;

    // Always scrub any historical plaintext copy first
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch {
      /* ignore */
    }

    if (!api?.setSessionCredentials) {
      // Attack prevented: writing accessToken to localStorage when Keychain IPC is missing
      throw new Error(
        "Secure session storage unavailable. Please sign in again.",
      );
    }

    const result = await api.setSessionCredentials(creds);
    try {
      localStorage.removeItem(SESSION_KEY);
    } catch {
      /* ignore */
    }

    if (!result || result.ok === false) {
      // Fail closed — no matrix-session.json / localStorage plaintext fallback
      throw new Error(
        (result && "reason" in result && result.reason) ||
          "Failed to persist session securely (OS encryption required).",
      );
    }
  }
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.length; i++) {
    binary += String.fromCharCode(bytes[i]!);
  }
  return btoa(binary);
}

function base64ToUint8Array(b64: string): Uint8Array<ArrayBuffer> {
  const binary = atob(b64);
  const out = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) {
    out[i] = binary.charCodeAt(i);
  }
  return out as Uint8Array<ArrayBuffer>;
}

export const matrixService = MatrixService.getInstance();
