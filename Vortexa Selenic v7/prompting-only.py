import sys
import io

# Force stdout to use UTF-8
sys.stdout = io.TextIOWrapper(sys.stdout.buffer, encoding="utf-8")

with open("app.py", "r", encoding="utf-8") as f:
    code = f.read()

with open("style.css", "r", encoding="utf-8") as f:
    style = f.read()

with open("script.js", "r", encoding="utf-8") as f:
    script = f.read()

with open("index.html", "r", encoding="utf-8") as f:
    index = f.read()

print("How do I remove the cloud?:\n")

print("=== Backend (app.py) ===")
print("'''")
print(code)
print("'''\n")

print("=== Frontend (style.css) ===")
print("'''")
print(style)
print("'''\n")

print("=== Script (script.js) ===")
print("'''")
print(script)
print("'''\n")

print("=== Index (index.html) ===")
print("'''")
print(index)
print("'''")
