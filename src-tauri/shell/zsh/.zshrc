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
# 133;A — начало приглашения, 133;C;<base64 команды> — старт, 133;D;<код> — конец,
# 133;A;k=s — вторичное приглашение (PS2): команда не закончена, ZLE ждёт продолжения,
# 133;I — ZLE приняла строку.
# Последний параметр каждого маркера — `kv=<метка сессии>` (из .zshenv): маркеры без неё
# терминал игнорирует, их мог напечатать кто угодно (`cat` файла, программа, ssh).
if [[ -n "$KV_BLOCKS" ]]; then
  typeset -g _kv_cmd_ran=
  _kv_blocks_precmd() {
    local ret=$?
    emulate -L zsh
    if [[ -n "$_kv_cmd_ran" ]]; then
      printf '\e]133;D;%s;kv=%s\a' "$ret" "$_kv_mark"
      _kv_cmd_ran=
    fi
    printf '\e]133;A;kv=%s\a' "$_kv_mark"
  }
  _kv_blocks_preexec() {
    emulate -L zsh
    _kv_cmd_ran=1
    # base64 может переносить строки на 76 символах — склеиваем.
    local b64
    b64=$(print -rn -- "$1" | command base64 | command tr -d '\n')
    printf '\e]133;C;%s;kv=%s\a' "$b64" "$_kv_mark"
  }
  _kv_blocks_hide_prompt() {
    PROMPT=''
    # Вместо текста PS2 — только маркер: строка ввода покажет подсказку «Команда не закончена».
    PROMPT2=$'%{\e]133;A;k=s;kv='"$_kv_mark"$'\a%}'
    RPROMPT=''
    PROMPT_EOL_MARK=''
  }
  # Строка ввода отправляет команду целиком (bracketed paste + ↵) в невидимый ZLE. Опции, при которых
  # ZLE оставляет ввод в буфере или задаёт вопрос, ломают это: hist_verify вернул бы раскрытый `!!`
  # в буфер (и он склеился бы со следующей командой), correct спросил бы невидимое [nyae]?.
  # Восстанавливаем и bracketed paste. Повторяем перед каждым приглашением — rc/плагины могли поменять.
  _kv_blocks_zle_opts() {
    unsetopt hist_verify correct correct_all
    typeset -g zle_bracketed_paste
    zle_bracketed_paste=($'\e[?2004h' $'\e[?2004l')
    local km
    for km in emacs viins vicmd main; do
      bindkey -M $km '^[[200~' bracketed-paste 2>/dev/null
    done
  }
  _kv_blocks_zle_opts
  # 133;I — ZLE приняла строку (после её эха): терминал стирает эхо; вывод до 133;C или 133;A
  # (ошибка разбора и т. п.) становится отдельным блоком, а не теряется.
  _kv_blocks_line_finish() {
    print -rn -- $'\e]133;I;kv='"$_kv_mark"$'\a'
  }
  autoload -Uz add-zle-hook-widget
  add-zle-hook-widget line-finish _kv_blocks_line_finish
  # Наш precmd идёт первым, чтобы $? не затёрли пользовательские хуки.
  precmd_functions=(_kv_blocks_precmd ${precmd_functions:#_kv_blocks_precmd})
  add-zsh-hook preexec _kv_blocks_preexec
  add-zsh-hook precmd _kv_blocks_zle_opts
  # Скрывающий хук — последним: тема могла вернуть приглашение.
  add-zsh-hook precmd _kv_blocks_hide_prompt
  _kv_blocks_hide_prompt
fi

# Сообщаем терминалу текущий каталог (OSC 7) перед каждым приглашением.
# После URL — `;kv=<метка>`: `;` в пути закодирован как %3B, так что разбор однозначен.
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
  printf '\e]7;file://%s%s;kv=%s\a' "$HOST" "$out" "$_kv_mark"
}
add-zsh-hook precmd _kv_osc7
