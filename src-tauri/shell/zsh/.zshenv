# KodeVertex Terminal: интеграция zsh через ZDOTDIR.

# Метка маркеров OSC 133/7 (KODEVERTEX_MARK): переносим в неэкспортируемую переменную
# и снимаем с окружения до пользовательских файлов — запущенные команды её не увидят,
# а значит не смогут подделать маркеры (фальшивые блоки, код возврата, каталог).
typeset -g +x _kv_mark="${KODEVERTEX_MARK-}"
unset KODEVERTEX_MARK

# Временно возвращаем пользовательский ZDOTDIR, подключаем его .zshenv
# и снова переключаемся на наш каталог интеграции.
KV_ZDOTDIR="${KV_ZDOTDIR:-$ZDOTDIR}"
ZDOTDIR="${KV_ORIG_ZDOTDIR:-$HOME}"
[[ -f "$ZDOTDIR/.zshenv" ]] && source "$ZDOTDIR/.zshenv"
# Пользовательский файл мог сам сменить ZDOTDIR — запоминаем его выбор.
[[ "$ZDOTDIR" != "${KV_ORIG_ZDOTDIR:-$HOME}" ]] && KV_ORIG_ZDOTDIR="$ZDOTDIR"
ZDOTDIR="$KV_ZDOTDIR"
