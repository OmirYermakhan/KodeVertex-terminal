# KodeVertex Terminal: интеграция zsh через ZDOTDIR.
# Временно возвращаем пользовательский ZDOTDIR, подключаем его .zlogin
# и снова переключаемся на наш каталог интеграции.
KV_ZDOTDIR="${KV_ZDOTDIR:-$ZDOTDIR}"
ZDOTDIR="${KV_ORIG_ZDOTDIR:-$HOME}"
[[ -f "$ZDOTDIR/.zlogin" ]] && source "$ZDOTDIR/.zlogin"
# Пользовательский файл мог сам сменить ZDOTDIR — запоминаем его выбор.
[[ "$ZDOTDIR" != "${KV_ORIG_ZDOTDIR:-$HOME}" ]] && KV_ORIG_ZDOTDIR="$ZDOTDIR"
# .zlogin — последний файл login-shell: окончательно отдаём ZDOTDIR пользователю.
if [[ -n "$KV_ORIG_ZDOTDIR" ]]; then
  export ZDOTDIR="$KV_ORIG_ZDOTDIR"
else
  unset ZDOTDIR
fi
unset KV_ZDOTDIR KV_ORIG_ZDOTDIR
