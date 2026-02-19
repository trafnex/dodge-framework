from flask import Flask, send_from_directory, abort
from flask_cors import CORS
import os

HERE = os.path.dirname(os.path.abspath(__file__))
BASE_DIR = os.path.abspath(os.path.join(HERE, ".."))

app = Flask(__name__, static_folder=None)
CORS(app)

@app.get("/")
def index():
    return send_from_directory(BASE_DIR, "artifact/test.html")

@app.get("/<path:req_path>")
def serve_any(req_path: str):
    abs_path = os.path.abspath(os.path.join(BASE_DIR, req_path))
    if not abs_path.startswith(os.path.abspath(BASE_DIR) + os.sep):
        abort(403)

    if not os.path.isfile(abs_path):
        abort(404)

    return send_from_directory(BASE_DIR, req_path)

if __name__ == "__main__":
    app.run(host="127.0.0.1", port=5000, debug=True)