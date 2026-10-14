# Oracle Cloud Always Free VM Deployment Guide

This guide walks you through deploying the **Vinehill Media Bot & 2GB File Renaming Engine** on your Oracle Cloud Always Free Ubuntu VM.

---

### 1. Connect to your Oracle VM via SSH
Open your terminal (PowerShell, Command Prompt, or Mac/Linux terminal) and run:
```bash
# Set file permission on your SSH key (Mac/Linux only)
chmod 400 ssh-key.key

# Connect (replace with your Oracle Public IP)
ssh -i /path/to/ssh-key.key ubuntu@YOUR_ORACLE_PUBLIC_IP
```

---

### 2. Install Docker & Docker Compose (One-Time Setup)
Run these commands on your Ubuntu VM:
```bash
sudo apt update && sudo apt upgrade -y
sudo apt install -y docker.io docker-compose git

# Allow ubuntu user to run Docker without sudo
sudo usermod -aG docker ubuntu
newgrp docker
```

---

### 3. Open Firewall Port 3000 (Optional, for Admin Dashboard)
If you want to view the web dashboard from your browser:
```bash
sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport 3000 -j ACCEPT
sudo netfilter-persistent save 2>/dev/null || sudo iptables-save | sudo tee /etc/iptables/rules.v4
```

---

### 4. Clone Your Codebase & Set Environment Variables
```bash
git clone <YOUR_GITHUB_REPO_URL> vinehill-bot
cd vinehill-bot

# Create your .env file
cp .env.example .env
nano .env
```

Fill in your actual tokens and IDs inside `.env`:
* `BOT_TOKEN`: From `@BotFather`
* `API_ID` & `API_HASH`: From [my.telegram.org](https://my.telegram.org) (required for 2GB MTProto downloads/uploads)
* `STORAGE_MOVIES`, `STORAGE_SERIES`, `STORAGE_ANIME`: The numeric IDs of the staging channels where you forward raw files
* `RENAMED_MOVIES`: `@renamed_movies`
* `RENAMED_SERIES`: `@renamed_series`
* `RENAMED_ANIME`: `@renamed_anime`
* `CH_MAIN`: `@VinehillMain`
* `CH_MOVIES`: `@VinehillMovies`
* `CH_SERIES`: `@VinehillSeries`
* `CH_ANIME`: `@VinehillAnime`
* `ADMIN_ID`: Your Telegram numeric User ID

Press `Ctrl + O` then `Enter` to save, and `Ctrl + X` to exit `nano`.

---

### 5. Launch the Bot with Docker
```bash
docker compose up -d --build
```

That's it! The bot is now running 24/7 in the background:
* Files forwarded to raw staging channels are automatically downloaded, renamed according to:
  `Title (Year) [1080p] @VinehillMain .mkv`
* Re-uploaded to `@renamed_movies`, `@renamed_series`, or `@renamed_anime`
* Indexed in the database and automatically announced to `@VinehillMain` and sub-channels!
* The container restarts automatically if the server reboots (`restart: always`).

---

### Useful Commands
* **View live logs**:
  ```bash
  docker compose logs -f
  ```
* **Restart the bot**:
  ```bash
  docker compose restart
  ```
* **Stop the bot**:
  ```bash
  docker compose down
  ```
