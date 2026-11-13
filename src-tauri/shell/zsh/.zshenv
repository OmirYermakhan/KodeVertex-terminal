# KodeVertex Terminal: интеграция zsh через ZDOTDIR.

# Метка маркеров OSC 133/7 (KODEVERTEX_MARK): переносим в неэкспортируемую переменную
# и снимаем с окружения до пользовательских файлов. В окружение команд она возвращается
# только на время команды (_kv_env_preexec в .zshrc) — так `exec zsh` и вложенный zsh
# остаются с интеграцией. Чужой вывод (`cat` файла, ssh, программа) метки не знает.
typeset -g +x _kv_mark="${KODEVERTEX_MARK-}"
unset KODEVERTEX_MARK

# Наш каталог интеграции: zsh прочёл этот файл из $ZDOTDIR.
typeset -g _kv_zdotdir="$ZDOTDIR"
# ZDOTDIR пользователя (пусто — $HOME) — обычная переменная оболочки, не окружения.
typeset -g +x KV_ORIG_ZDOTDIR="${KV_ORIG_ZDOTDIR-}"

# Временно возвращаем пользовательский ZDOTDIR и подключаем его .zshenv.
ZDOTDIR="${KV_ORIG_ZDOTDIR:-$HOME}"
[[ -f "$ZDOTDIR/.zshenv" ]] && source "$ZDOTDIR/.zshenv"
# Пользовательский файл мог сам сменить ZDOTDIR — запоминаем его выбор.
[[ "$ZDOTDIR" != "${KV_ORIG_ZDOTDIR:-$HOME}" ]] && KV_ORIG_ZDOTDIR="$ZDOTDIR"

# Интеграция — только для интерактивного zsh в нашем терминале и с меткой сессии. Скрипт (`zsh -c`,
# `#!/bin/zsh`), tmux/screen или окружение, утёкшее в чужой терминал, получают ZDOTDIR пользователя:
# остальные файлы (.zprofile, .zshrc, .zlogin) zsh прочтёт уже у него.
if [[ -o interactive && -n "$_kv_mark" && "$TERM_PROGRAM" == KodeVertex && -z "$TMUX$STY" ]]; then
  ZDOTDIR="$_kv_zdotdir"
else
  if [[ -n "$KV_ORIG_ZDOTDIR" ]]; then
    export ZDOTDIR="$KV_ORIG_ZDOTDIR"
  else
    unset ZDOTDIR
  fi
  unset KV_ORIG_ZDOTDIR _kv_zdotdir _kv_mark
fi
