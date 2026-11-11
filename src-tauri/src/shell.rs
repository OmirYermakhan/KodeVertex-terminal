use std::path::PathBuf;

use tauri::path::BaseDirectory;
use tauri::{AppHandle, Manager, Runtime};

/// Запасная оболочка, если `$SHELL` не задан.
const FALLBACK_SHELL: &str = "/bin/zsh";

/// Каталог с файлами интеграции zsh (`.zshenv`, `.zshrc`, …) из ресурсов приложения.
pub fn integration_dir<R: Runtime>(app: &AppHandle<R>) -> PathBuf {
  app
    .path()
    .resolve("shell/zsh", BaseDirectory::Resource)
    .unwrap_or_else(|_| PathBuf::from(env!("CARGO_MANIFEST_DIR")).join("shell/zsh"))
}

/// Оболочка пользователя: `SHELL` из переопределений, затем из окружения, иначе `/bin/zsh`.
pub fn login_shell(env_overrides: &[(String, String)]) -> String {
  env_overrides
    .iter()
    .rev()
    .find(|(k, _)| k == "SHELL")
    .map(|(_, v)| v.clone())
    .or_else(|| std::env::var("SHELL").ok())
    .filter(|s| !s.is_empty())
    .unwrap_or_else(|| FALLBACK_SHELL.to_string())
}

/// Базовое окружение терминальной сессии. `zdotdir` — наш каталог интеграции,
/// `orig_zdotdir` — ZDOTDIR, который был у пользователя (или пусто).
pub fn session_env(zdotdir: &std::path::Path, orig_zdotdir: Option<String>) -> Vec<(String, String)> {
  let mut env = vec![
    ("TERM".to_string(), "xterm-256color".to_string()),
    ("COLORTERM".to_string(), "truecolor".to_string()),
    ("TERM_PROGRAM".to_string(), "KodeVertex".to_string()),
    ("KV_ORIG_ZDOTDIR".to_string(), orig_zdotdir.unwrap_or_default()),
    ("ZDOTDIR".to_string(), zdotdir.to_string_lossy().into_owned()),
  ];
  // Приложение, запущенное из Finder, не получает LANG — без него zsh не понимает UTF-8.
  let has_locale = ["LC_ALL", "LC_CTYPE", "LANG"]
    .iter()
    .any(|k| std::env::var(k).map(|v| !v.is_empty()).unwrap_or(false));
  if !has_locale {
    env.push(("LANG".to_string(), "en_US.UTF-8".to_string()));
  }
  env
}

#[cfg(test)]
mod tests {
  use super::*;

  #[test]
  fn login_shell_prefers_override() {
    let env = vec![("SHELL".to_string(), "/bin/bash".to_string())];
    assert_eq!(login_shell(&env), "/bin/bash");
  }

  #[test]
  fn session_env_sets_integration_vars() {
    let env = session_env(std::path::Path::new("/r/shell/zsh"), None);
    let get = |k: &str| env.iter().find(|(n, _)| n == k).map(|(_, v)| v.as_str());
    assert_eq!(get("TERM"), Some("xterm-256color"));
    assert_eq!(get("COLORTERM"), Some("truecolor"));
    assert_eq!(get("TERM_PROGRAM"), Some("KodeVertex"));
    assert_eq!(get("KV_ORIG_ZDOTDIR"), Some(""));
    assert_eq!(get("ZDOTDIR"), Some("/r/shell/zsh"));
  }
}
