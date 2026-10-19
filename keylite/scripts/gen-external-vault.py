"""反向互操作：用 pykeepass 创建一个库，供 KeyLite（kdbxweb）读取。"""
from pykeepass import create_database

DB = r"D:\workbuddy\Easy\keylite\test-vault-external.kdbx"

kp = create_database(DB, password="external-pass")
group = kp.add_group(kp.root_group, "外部实现")
entry = kp.add_entry(group, "Firefox", "jong", "Fx!Pass2026")
entry.url = "https://firefox.com"
entry.notes = "由 pykeepass 写入"
kp.save()
print("written:", DB)
print("kdf:", kp.kdbx.header.value.dynamic_header.kdf_parameters.data)
