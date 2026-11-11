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
  # Полное кодирование пути по RFC 3986: побайтово, на чистом zsh.
  local LC_ALL=C
  local p=$PWD out= c i
  for (( i = 1; i <= ${#p}; i++ )); do
    c=${p[i]}
    if [[ $c == [A-Za-z0-9._~/-] ]]; then
      out+=$c
    else
      out+=$(printf '%%%02X' "'$c")
    fi
  done
  printf '\e]7;file://%s%s\a' "$HOST" "$out"
}
add-zsh-hook precmd _kv_osc7

# Сообщаем терминалу строку ввода ZLE (OSC 6973): позиция курсора и буфер.
# add-zle-hook-widget складывается с хуками, уже заданными пользователем.
autoload -Uz add-zle-hook-widget
_kv_report_buffer() {
  local b=${BUFFER//$'\e'/}
  b=${b//$'\a'/}
  print -rn -- $'\e]6973;'"$CURSOR;$b"$'\a'
}
_kv_report_end() {
  print -rn -- $'\e]6973;-\a'
}
add-zle-hook-widget line-pre-redraw _kv_report_buffer
add-zle-hook-widget line-finish _kv_report_end
