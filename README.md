<p align="center"><img src="docs/brand/app-icon.svg" width="128" alt="KodeVertex Terminal"></p>

# KodeVertex Terminal

*A reading-friendly terminal for macOS with Claude Code integration (Tauri 2 + React + TypeScript). Early foundation stage.*

Терминал, удобный для чтения: крупный аккуратный текст, встроенные шрифты с кириллицей, темы и интеграция с Claude Code.

## Что уже работает

- вкладки и разделение панелей (вправо и вниз);
- zsh с собственной интеграцией через `ZDOTDIR` (ваши `~/.zshrc` и прочие файлы не меняются и подгружаются как обычно);
- темы (по умолчанию Android Studio) и шрифты Inter / JetBrains Mono, настройка размера;
- окно настроек, статус-бар (проект, ветка, папка, время);
- конфиг в TOML.

## В планах

- блоки команд;
- интеграция с Claude;
- релизы для разных платформ.

## Сборка из исходников

Нужны [Rust](https://rustup.rs) (`rustup`), Node.js и Xcode.

```sh
npm i
npm run tauri dev     # запуск в режиме разработки
npm run tauri build   # сборка .app и .dmg
```

Готовый `.dmg` появится в `src-tauri/target/release/bundle/dmg/`.

## Первый запуск на macOS

Приложение не подписано, поэтому macOS может отказаться его открыть. Откройте его через правый клик → «Открыть», либо снимите карантин:

```sh
xattr -dr com.apple.quarantine "/Applications/KodeVertex Terminal.app"
```

## Горячие клавиши

| Действие | Клавиши |
|---|---|
| Разделить вправо | ⌘D |
| Разделить вниз | ⌘⇧D |
| Новая вкладка | ⌘T |
| Закрыть панель | ⌘W |
| Фокус на соседнюю панель | ⌥⌘ + стрелки |
| Вкладка 1–8 / последняя | ⌘1–⌘8 / ⌘9 |
| Предыдущая / следующая вкладка | ⌘⇧[ / ⌘⇧] |
| Увеличить / уменьшить / сбросить шрифт | ⌘+ / ⌘- / ⌘0 |
| Настройки | ⌘, |

## Конфиг

`~/.config/kodevertex-terminal/settings.toml`

## Лицензия

[MIT](LICENSE)
