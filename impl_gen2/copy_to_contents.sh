#!/usr/bin/env bash
set -euo pipefail

script_dir="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")" && pwd)"
destination="$script_dir/../docs/gen2"
files=(index.html style.css game.js learn.js words.js)

for file in "${files[@]}"; do
  if [[ ! -f "$script_dir/src/$file" ]]; then
    printf 'Source file not found: %s\n' "$script_dir/src/$file" >&2
    exit 1
  fi
done

mkdir -p -- "$destination"
for file in "${files[@]}"; do
  cp -f -- "$script_dir/src/$file" "$destination/$file"
done

printf 'Copied game files to %s\n' "$destination"
