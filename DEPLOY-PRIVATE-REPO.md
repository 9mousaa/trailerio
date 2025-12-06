# Deploying Private Repository

Your repo requires authentication. Here are the options:

## Option 1: Make Repository Public (Easiest)

1. Go to: https://github.com/9mousaa/trailerio/settings
2. Scroll down to "Danger Zone"
3. Click "Change visibility" → "Make public"

Then run the deployment command again.

## Option 2: Use SSH with Deploy Key (Recommended for Private Repos)

### Step 1: Generate SSH Key on VPS

```bash
ssh-keygen -t ed25519 -C "vps-deploy" -f ~/.ssh/trailerio_deploy -N ""
cat ~/.ssh/trailerio_deploy.pub
```

Copy the public key that's displayed.

### Step 2: Add Deploy Key to GitHub

1. Go to: https://github.com/9mousaa/trailerio/settings/keys
2. Click "Add deploy key"
3. Paste the public key
4. Give it a title: "VPS Deploy"
5. Check "Allow write access" (optional, only if you want to push)
6. Click "Add key"

### Step 3: Update Git URL to SSH

```bash
cd /opt/trailerio
git remote set-url origin git@github.com:9mousaa/trailerio.git
```

Or clone with SSH from the start:

```bash
cd /opt
git clone git@github.com:9mousaa/trailerio.git trailerio
cd trailerio
docker compose up -d --build
```

## Option 3: Use Personal Access Token

### Step 1: Create Token on GitHub

1. Go to: https://github.com/settings/tokens
2. Click "Generate new token" → "Generate new token (classic)"
3. Give it a name: "VPS Deploy"
4. Select scopes: `repo` (full control of private repositories)
5. Click "Generate token"
6. **Copy the token immediately** (you won't see it again!)

### Step 2: Use Token in Clone Command

```bash
# Replace YOUR_TOKEN with the token you just created
cd /opt
git clone https://YOUR_TOKEN@github.com/9mousaa/trailerio.git trailerio
cd trailerio
docker compose up -d --build
```

Or update existing repo:

```bash
cd /opt/trailerio
git remote set-url origin https://YOUR_TOKEN@github.com/9mousaa/trailerio.git
git pull
```

## Option 4: Manual Upload (If repo stays private)

If you want to keep it private and don't want to set up auth:

1. **On your local machine**, create a tarball:
   ```bash
   cd /Users/mousa/Proejcts/trailerio
   tar -czf trailerio.tar.gz --exclude='.git' --exclude='node_modules' --exclude='dist' .
   ```

2. **Upload to VPS**:
   ```bash
   scp trailerio.tar.gz root@143.110.166.25:/opt/
   ```

3. **On VPS**, extract and deploy:
   ```bash
   cd /opt
   mkdir -p trailerio
   tar -xzf trailerio.tar.gz -C trailerio
   cd trailerio
   docker compose up -d --build
   ```

## Quick Fix: Make Public (Fastest)

The quickest solution is to make the repo public temporarily, deploy, then make it private again if needed.

