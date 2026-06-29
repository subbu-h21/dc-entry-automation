import subprocess
import re
import sys
import shutil

def main():
    if not shutil.which("cloudflared"):
        print("ERROR: cloudflared not found.")
        print("Download it from https://developers.cloudflare.com/cloudflare-one/connections/connect-networks/downloads/")
        input("\nPress Enter to exit...")
        sys.exit(1)

    print("Starting Cloudflare tunnel to http://localhost:3001 ...")
    print("Waiting for tunnel URL...\n")

    proc = subprocess.Popen(
        ["cloudflared", "tunnel", "--url", "http://localhost:3001"],
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        encoding="utf-8",
        errors="replace",
    )

    url = None
    for line in proc.stdout:
        match = re.search(r"https://[a-z0-9-]+\.trycloudflare\.com", line)
        if match:
            url = match.group(0)
            break

    if not url:
        print("Could not detect tunnel URL. Cloudflared may have failed to start.")
        proc.wait()
        input("\nPress Enter to exit...")
        sys.exit(1)

    print(f"Tunnel live: {url}\n")
    print("Scan this QR code with your phone:\n")

    try:
        import qrcode
        qr = qrcode.QRCode(border=1)
        qr.add_data(url)
        qr.make(fit=True)
        qr.print_ascii(invert=True)
    except ImportError:
        print("(qrcode not installed — run setup.bat to install dependencies)")

    print(f"\n{url}\n")
    print("Tunnel is running. Close this window to stop it.")

    proc.wait()

if __name__ == "__main__":
    main()
