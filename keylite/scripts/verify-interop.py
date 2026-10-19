"""互操作验证（独立实现）：用 pykeepass 打开 KeyLite 写的 .kdbx，逐项校验。"""
from pykeepass import PyKeePass

DB = r"D:\workbuddy\Easy\keylite\test-vault.kdbx"
PASSWORD = "test-master-password"

kp = PyKeePass(DB, password=PASSWORD)
print("KDBX opened by pykeepass OK")
print("root group :", kp.root_group.name)
print("groups     :", [g.name for g in kp.groups])
print("entries    :", [(e.title, e.username) for e in kp.entries])

e = kp.find_entries(title="GitHub", first=True)
assert e is not None, "GitHub entry not found"
assert e.username == "jong@example.com", f"username mismatch: {e.username}"
assert e.password == "x9!Kp#mZ2vQ8", "password mismatch"
assert e.url == "https://github.com/login", f"url mismatch: {e.url}"

g = kp.find_entries(title="Google", first=True)
assert g is not None and g.password == "G00gle!Pass#2026"

print("ALL FIELDS MATCH -> INTEROP PASS")
