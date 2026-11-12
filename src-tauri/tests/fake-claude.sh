#!/bin/bash
# Подделка `claude` для тестов: печатает события из фикстуры, затем эхо строк stdin.
dir="$(cd "$(dirname "$0")" && pwd)"
cat "$dir/../../src/claude/fixtures/bash-ls.jsonl"
while IFS= read -r line; do
  printf '{"type":"echo","line":%s}\n' "$line"
done
