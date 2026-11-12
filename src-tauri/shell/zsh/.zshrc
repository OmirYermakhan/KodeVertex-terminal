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

autoload -Uz add-zsh-hook

# Режим блоков (KV_BLOCKS=1): границы команд по OSC 133 и скрытое приглашение.
# 133;A — начало приглашения, 133;C;<base64 команды> — старт, 133;D;<код> — конец.
if [[ -n "$KV_BLOCKS" ]]; then
  typeset -g _kv_cmd_ran=
  _kv_blocks_precmd() {
    local ret=$?
    emulate -L zsh
    if [[ -n "$_kv_cmd_ran" ]]; then
      printf '\e]133;D;%s\a' "$ret"
      _kv_cmd_ran=
    fi
    printf '\e]133;A\a'
  }
  _kv_blocks_preexec() {
    emulate -L zsh
    _kv_cmd_ran=1
    # base64 может переносить строки на 76 символах — склеиваем.
    local b64
    b64=$(print -rn -- "$1" | command base64 | command tr -d '\n')
    printf '\e]133;C;%s\a' "$b64"
  }
  _kv_blocks_hide_prompt() {
    PROMPT=''
    RPROMPT=''
    PROMPT_EOL_MARK=''
  }
  # Наш precmd идёт первым, чтобы $? не затёрли пользовательские хуки.
  precmd_functions=(_kv_blocks_precmd ${precmd_functions:#_kv_blocks_precmd})
  add-zsh-hook preexec _kv_blocks_preexec
  # Скрывающий хук — последним: тема могла вернуть приглашение.
  add-zsh-hook precmd _kv_blocks_hide_prompt
  _kv_blocks_hide_prompt
fi

# Сообщаем терминалу текущий каталог (OSC 7) перед каждым приглашением.
_kv_osc7() {
  emulate -L zsh
  # Полное кодирование пути по RFC 3986: побайтово, на чистом zsh.
  local LC_ALL=C
  local p=$PWD out= c i
  for (( i = 1; i <= ${#p}; i++ )); do
    c=${p[i]}
    if [[ $c == [A-Za-z0-9._~/-] ]]; then
      out+=$c
    else
      printf -v c '%%%02X' "'$c"
      out+=$c
    fi
  done
  printf '\e]7;file://%s%s\a' "$HOST" "$out"
}
add-zsh-hook precmd _kv_osc7

# Сообщаем терминалу строку ввода ZLE (OSC 6973): позиция курсора и буфер.
# add-zle-hook-widget складывается с хуками, уже заданными пользователем.
autoload -Uz add-zle-hook-widget
typeset -g _kv_last_report=
_kv_report_buffer() {
  emulate -L zsh
  # Управляющие символы заменяем пробелом: OSC не рвётся, CURSOR не сдвигается.
  local b=${BUFFER//[[:cntrl:]]/ }
  [[ "$CURSOR:$b" == "$_kv_last_report" ]] && return
  _kv_last_report="$CURSOR:$b"
  print -rn -- $'\e]6973;'"$CURSOR;$b"$'\a'
}
_kv_report_end() {
  emulate -L zsh
  _kv_last_report=
  print -rn -- $'\e]6973;-\a'
}
add-zle-hook-widget line-pre-redraw _kv_report_buffer
add-zle-hook-widget line-finish _kv_report_end
