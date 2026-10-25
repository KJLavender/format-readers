import hashlib

SECRET_SALT = "salt-for-prototype-test"

def check_key(key):
    digest = hashlib.sha256((SECRET_SALT + key).encode()).hexdigest()
    return digest.startswith("0")
