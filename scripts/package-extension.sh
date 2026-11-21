#!/usr/bin/env bash
set -euo pipefail

output=${1:?Usage: package-extension.sh OUTPUT.zip [GIT_REVISION]}
revision=${2:-HEAD}

# Use the committed runtime files. Chrome expects manifest.json at the ZIP root.
git archive --format=zip --output="$output" "$revision" -- \
  LICENSE manifest.json sidepanel.html ':(top,glob)*.js' ':(top,glob)icons/*.png'
unzip -tq "$output"
