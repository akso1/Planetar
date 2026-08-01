# matrix-macos-client

Нативно-ощутимый настольный клиент [Matrix](https://matrix.org/) для macOS, построенный на
Electron + React 19 + TypeScript. Шифрование — через Rust-crypto (`matrix-js-sdk` +
`@matrix-org/matrix-sdk-crypto-wasm`), хранение — IndexedDB.

## Возможности

- E2E-шифрование (Rust crypto, Olm/Megolm)
- Список чатов с папками (Все / Личные / Группы), закреплением и drag-and-drop
- Поиск по чатам, сообщениям (локально + серверный) и людям/публичным комнатам
- Тайный просмотр чата долгим зажатием аватара (без отметки «прочитано»)
- Богатый композер: markdown, эмодзи/стикеры/GIF, ответы, цитаты, правки, упоминания
- Черновики на комнату (текст переживает перезапуск, вложения — в рамках сессии)
- Десктоп-уведомления, бейдж док-ярлыка, темы оформления (dark/light/telegram/matrix/cyberpunk)

## Требования

- Node.js 18+ и npm
- macOS (сборка под `.app`/`.dmg` идёт через electron-builder)

## Установка

```bash
npm install
```

Эмодзи-ассеты (twemoji PNG) не лежат в репозитории. Скачайте их перед первым запуском:

```bash
./scripts/fetch-twemoji.sh
```

## Запуск

```bash
npm run dev      # Vite + Electron с HMR
```

## Сборка

```bash
npm run build    # vite build + electron-builder
npm run preview  # предпросмотр собранной web-сборки без Electron
```

## Линт

```bash
npm run lint     # oxlint
```

Проверка типов (скрипта в package.json нет, запускается вручную):

```bash
npx tsc --noEmit
```

## Структура

```
electron/      — главный процесс Electron (окно, IPC, SSO, поиск GIF)
src/
  entities/    — Zustand-сторы: сессия, комнаты, инвайты
  features/    — авторизация
  shared/      — MatrixService, библиотеки (черновики, медиа, темы…), UI-компоненты
  widgets/     — крупные виджеты (ChatList, MessageTimeline, MessageInput, Settings…)
  pages/       — MainLayout
```
