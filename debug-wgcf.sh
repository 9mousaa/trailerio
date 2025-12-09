#!/bin/bash
# Debug script for wgcf issues

echo "=== wgcf Debug Information ==="
echo ""

echo "1. Checking wgcf installation:"
which wgcf || echo "wgcf not in PATH"
wgcf --version 2>&1 || echo "wgcf --version failed"
echo ""

echo "2. Checking wgcf binary details:"
if command -v wgcf &> /dev/null; then
    file $(which wgcf) 2>&1
    ls -lh $(which wgcf) 2>&1
fi
echo ""

echo "3. Testing wgcf help:"
wgcf --help 2>&1 | head -30
echo ""

echo "4. Testing wgcf status:"
cd /tmp
wgcf status 2>&1
echo ""

echo "5. Testing wgcf register (verbose):"
wgcf register 2>&1
echo "Exit code: $?"
echo ""

echo "6. Checking for account file after register:"
find /tmp /root /home -name "*wgcf*" -o -name "*account*" 2>/dev/null | head -10
ls -la /tmp/wgcf* 2>/dev/null || echo "No wgcf files in /tmp"
echo ""

echo "7. Testing wgcf generate (verbose):"
wgcf generate 2>&1
echo "Exit code: $?"
echo ""

echo "8. Checking for profile file after generate:"
find /tmp /root /home -name "*profile*" -o -name "*wgcf*.conf" 2>/dev/null | head -10
ls -la /tmp/wgcf* 2>/dev/null || echo "No wgcf files in /tmp"
echo ""

echo "9. Current directory and environment:"
pwd
echo "HOME: $HOME"
echo "USER: $USER"
env | grep -i wgcf || echo "No WGCF env vars"
echo ""

echo "=== End Debug Information ==="

