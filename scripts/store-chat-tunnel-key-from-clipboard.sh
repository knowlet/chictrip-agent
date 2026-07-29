#!/bin/sh

set -eu

key_dir="${CHICTRIP_STATE_DIR:-$HOME/.local/share/chictrip-agent}"
key_file="$key_dir/openai-tunnel-runtime-key"

if ! command -v pbpaste >/dev/null 2>&1; then
  echo "pbpaste is required on macOS to store the copied runtime key." >&2
  exit 1
fi

runtime_key=$(pbpaste)
if ! printf '%s' "$runtime_key" | grep -Eq '^sk-[A-Za-z0-9._-]{16,}$'; then
  unset runtime_key
  echo "Clipboard does not contain an OpenAI secret key. Nothing was written." >&2
  exit 1
fi

umask 077
mkdir -p "$key_dir"
chmod 0700 "$key_dir"

temporary_key_file=$(mktemp "$key_dir/.openai-tunnel-runtime-key.XXXXXX")
cleanup() {
  if [ -n "${temporary_key_file:-}" ] && [ -f "$temporary_key_file" ]; then
    rm -f -- "$temporary_key_file"
  fi
}
trap cleanup EXIT HUP INT TERM

printf '%s' "$runtime_key" > "$temporary_key_file"
unset runtime_key
chmod 0600 "$temporary_key_file"
mv -f -- "$temporary_key_file" "$key_file"
temporary_key_file=""

# Minimize how long the credential remains in the system clipboard.
if command -v pbcopy >/dev/null 2>&1; then
  printf '' | pbcopy
fi

echo "Stored the runtime key at $key_file with mode 0600 and cleared the clipboard."
