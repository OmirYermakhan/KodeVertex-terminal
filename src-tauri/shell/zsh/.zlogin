# KodeVertex Terminal: интеграция zsh через ZDOTDIR.
# Временно возвращаем пользовательский ZDOTDIR и подключаем его .zlogin.
ZDOTDIR="${KV_ORIG_ZDOTDIR:-$HOME}"
[[ -f "$ZDOTDIR/.zlogin" ]] && source "$ZDOTDIR/.zlogin"
# Пользовательский файл мог сам сменить ZDOTDIR — запоминаем его выбор.
[[ "$ZDOTDIR" != "${KV_ORIG_ZDOTDIR:-$HOME}" ]] && KV_ORIG_ZDOTDIR="$ZDOTDIR"
# .zlogin — последний файл login-shell: ZDOTDIR снова пользовательский (см. _kv_zdotdir_to_user).
_kv_zdotdir_to_user
