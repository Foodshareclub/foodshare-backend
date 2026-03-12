#!/usr/bin/env python3
import sys
import os
import re

def upsert_env(file_path, key, value):
    if not value:
        return

    # Quote the value if it has spaces or newlines
    if "\n" in value or " " in value or "\"" in value:
        # Escape existing double quotes and wrap in double quotes
        # We use literal newlines as most .env parsers handle them inside quotes
        escaped_value = value.replace('"', '\\"')
        safe_value = f'"{escaped_value}"'
    else:
        safe_value = value

    if os.path.exists(file_path):
        with open(file_path, "r") as f:
            content = f.read()
    else:
        content = ""

    # Ensure content ends with newline if not empty
    if content and not content.endswith("\n"):
        content += "\n"

    # Pattern to match the key at the start of a line
    # We use re.MULTILINE to match ^ at the start of any line
    # We match until the end of the line
    pattern = re.compile(rf"^{re.escape(key)}=.*$", re.MULTILINE)
    
    new_line = f"{key}={safe_value}"

    if pattern.search(content):
        # Substitute the existing line
        new_content = pattern.sub(new_line, content)
    else:
        # Append to the end
        new_content = content + new_line + "\n"

    with open(file_path, "w") as f:
        f.write(new_content)

if __name__ == "__main__":
    if len(sys.argv) < 3:
        print("Usage: upsert-env.py <key> <value> [file]")
        sys.exit(1)
    
    key = sys.argv[1]
    value = sys.argv[2]
    file_path = sys.argv[3] if len(sys.argv) > 3 else ".env"
    
    upsert_env(file_path, key, value)
