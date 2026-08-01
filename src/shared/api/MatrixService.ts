import {
  createClient,
  IndexedDBStore,
  MatrixClient,
  SyncState,
  type ILoginFlowsResponse,
  type IIdentityProvider,
} from "matrix-js-sdk";
import type { CryptoCallbacks } from "matrix-js-sdk/lib/crypto-api";

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

async function deleteCryptoIndexedDbs(prefix: string): Promise<void> {
  if (typeof indexedDB === "undefined") return;
  const names = [
    `${prefix}::matrix-sdk-crypto`,
    `${prefix}::matrix-sdk-crypto-meta`,
  ];
  for (const dbname of names) {
    await new Promise<void>((resolve) => {
      try {
        const req = indexedDB.deleteDatabase(dbname);
        req.onsuccess = () => resolve();
        req.onerror = () => resolve();
        req.onblocked = () => resolve();
      } catch {
        resolve();
      }
    });
  }
}

function isCryptoAccountMismatch(err: unknown): boolean {
  const msg = err instanceof Error ? err.message : String(err);
  return (
    msg.includes("doesn't match the account") ||
    msg.includes("account in the store doesn't match")
  );
}

class MatrixService {
  private static instance: MatrixService;
  public client: MatrixClient | null = null;
  private roomStore: IndexedDBStore | null = null;
  private startupPromise: Promise<boolean> | null = null;

  private cachedSecretStorageKey: {
    keyId: string;
    privateKey: Uint8Array<ArrayBuffer>;
  } | null = null;

  private readonly cryptoCallbacks: CryptoCallbacks = {
    getSecretStorageKey: async ({ keys }) => {
      const cached = this.cachedSecretStorageKey;
      if (!cached) return null;

      const keyId =
        cached.keyId in keys ? cached.keyId : Object.keys(keys)[0];
      if (!keyId || !keys[keyId]) return null;

      return [keyId, cached.privateKey];
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
  }

  public clearCachedSecretStorageKey(): void {
    this.cachedSecretStorageKey = null;
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
    const creds = this.getStoredCredentials();
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
        } catch (e) {
          console.error("Rust crypto init failed on resume:", e);
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

    this.storeCredentials({
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

    this.storeCredentials({
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

    // Persist rooms/sync token so relaunch paints the list without a cold /sync
    this.roomStore = new IndexedDBStore({
      indexedDB: globalThis.indexedDB,
      localStorage: globalThis.localStorage,
      dbName: roomStoreDbName(userId),
    });

    this.client = createClient({
      baseUrl,
      userId,
      accessToken,
      deviceId,
      store: this.roomStore,
      disableVoip: true,
      // Needed for TimelineWindow jumps (profile media → message in chat)
      timelineSupport: true,
      cryptoCallbacks: this.cryptoCallbacks,
    });

    try {
      await this.roomStore.startup();
    } catch (err) {
      console.warn("Room IndexedDBStore startup failed — continuing cold", err);
    }
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
   * Uses a per-device IndexedDB prefix and recovers from device-mismatch errors.
   */
  public async ensureCryptoReady(): Promise<void> {
    if (!this.client) {
      throw new Error("Matrix client is not initialised.");
    }
    if (this.client.getCrypto()) return;

    const deviceId = this.client.getDeviceId();
    const userId = this.client.getUserId();
    if (!deviceId || !userId) {
      throw new Error(
        "Cannot enable encryption: missing userId or deviceId. Please sign in again."
      );
    }

    const prefix = cryptoStorePrefixFor(userId, deviceId);
    localStorage.setItem(CRYPTO_PREFIX_KEY, prefix);

    const init = () =>
      this.client!.initRustCrypto({
        useIndexedDB: true,
        cryptoDatabasePrefix: prefix,
      });

    try {
      await init();
    } catch (err) {
      if (!isCryptoAccountMismatch(err)) throw err;

      console.warn(
        "Crypto store device mismatch — wiping incompatible IndexedDB and retrying:",
        err
      );
      // Wipe device-scoped store + legacy default store from earlier sessions
      await deleteCryptoIndexedDbs(prefix);
      await deleteCryptoIndexedDbs(DEFAULT_CRYPTO_PREFIX);
      await init();
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

    await this.client.startClient({ initialSyncLimit: INITIAL_SYNC_LIMIT });
  }

  public stop() {
    this.client?.stopClient();
  }

  public async logout(): Promise<void> {
    const client = this.client;
    const prefix =
      localStorage.getItem(CRYPTO_PREFIX_KEY) ||
      (client?.getUserId() && client?.getDeviceId()
        ? cryptoStorePrefixFor(client.getUserId()!, client.getDeviceId()!)
        : null);

    this.client = null;
    const roomStore = this.roomStore;
    this.roomStore = null;
    this.clearCachedSecretStorageKey();

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

    // Remove only our keys — never wipe the entire localStorage
    localStorage.removeItem(SESSION_KEY);
    localStorage.removeItem(CRYPTO_PREFIX_KEY);
    localStorage.removeItem(SSO_PENDING_BASEURL_KEY);
    try {
      sessionStorage.removeItem(SSO_PENDING_BASEURL_KEY);
    } catch {
      /* ignore */
    }
  }

  private getStoredCredentials(): StoredCredentials | null {
    const stored = localStorage.getItem(SESSION_KEY);
    if (stored) {
      try {
        const creds = JSON.parse(stored) as StoredCredentials;
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
    return null;
  }

  private storeCredentials(creds: StoredCredentials) {
    localStorage.setItem(SESSION_KEY, JSON.stringify(creds));
  }
}

export const matrixService = MatrixService.getInstance();
