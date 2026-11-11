# KodeVertex Terminal: интеграция zsh через ZDOTDIR.
# Временно возвращаем пользовательский ZDOTDIR, подключаем его .zshrc
# и снова переключаемся на наш каталог интеграции.
KV_ZDOTDIR="${KV_ZDOTDIR:-$ZDOTDIR}"
ZDOTDIR="${KV_ORIG_ZDOTDIR:-$HOME}"
# /etc/zshrc (macOS) задаёт HISTFILE от $ZDOTDIR, когда тот ещё указывает на нас.
[[ "$HISTFILE" == "$KV_ZDOTDIR/.zsh_history" ]] && HISTFILE="$ZDOTDIR/.zsh_history"
[[ -f "$ZDOTDIR/.zshrc" ]] && source "$ZDOTDIR/.zshrc"
# Пользовательский файл мог сам сменить ZDOTDIR — запоминаем его выбор.
[[ "$ZDOTDIR" != "${KV_ORIG_ZDOTDIR:-$HOME}" ]] && KV_ORIG_ZDOTDIR="$ZDOTDIR"
ZDOTDIR="$KV_ZDOTDIR"

# Сообщаем терминалу текущий каталог (OSC 7) перед каждым приглашением.
autoload -Uz add-zsh-hook
_kv_osc7() {
  printf '\e]7;file://%s%s\a' "$HOST" "${PWD// /%20}"
}
add-zsh-hook precmd _kv_osc7
