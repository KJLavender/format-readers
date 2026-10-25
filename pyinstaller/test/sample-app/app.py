"""Sample app for pyinstaller prototype tests."""
import json
from licenselib.checker import check_key, SECRET_SALT

API_URL = "https://api.example.test/v2/activate"

def main():
    print("demo app", API_URL)
    print(check_key("ABCD-1234"), SECRET_SALT)
    print(json.dumps({"ok": True}))

if __name__ == "__main__":
    main()
