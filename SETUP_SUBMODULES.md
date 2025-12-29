# Setting Up Git Submodules

After pushing `foodshare-backend` to GitHub, follow these steps to set up submodules in client repos.

## Step 1: Push foodshare-backend to GitHub

```bash
cd /Users/organic/dev/work/foodshare/foodshare-backend

# If you have URL rewrite issues, use this:
git -c url."git@github.com:".insteadOf="https://github.com/" push -u origin main

# Or use GitHub CLI:
gh repo create Foodshareclub/foodshare-backend --private --source=. --push
```

## Step 2: Set up submodule in foodshare (web)

```bash
cd /Users/organic/dev/work/foodshare/foodshare

# Remove existing supabase directory (BACKUP FIRST if you have uncommitted changes!)
rm -rf supabase

# Add as submodule
git submodule add https://github.com/Foodshareclub/foodshare-backend.git supabase

# Commit the change
git add .gitmodules supabase
git commit -m "chore: migrate supabase to shared backend submodule"
```

## Step 3: Set up submodule in foodshare-ios

```bash
cd /Users/organic/dev/work/foodshare/foodshare-ios

# Remove existing supabase directory (BACKUP FIRST if you have uncommitted changes!)
rm -rf supabase

# Add as submodule
git submodule add https://github.com/Foodshareclub/foodshare-backend.git supabase

# Commit the change
git add .gitmodules supabase
git commit -m "chore: migrate supabase to shared backend submodule"
```

## Working with Submodules

### Clone a repo with submodules

```bash
git clone --recurse-submodules https://github.com/Foodshareclub/foodshare.git
```

### Update submodule to latest

```bash
git submodule update --remote supabase
git add supabase
git commit -m "chore: update supabase submodule"
```

### Pull changes including submodule updates

```bash
git pull
git submodule update --init --recursive
```

### Make changes to the backend

```bash
# Enter the submodule
cd supabase

# Make changes, commit, push
git checkout main
git pull
# ... make changes ...
git add .
git commit -m "feat: add new migration"
git push

# Go back to parent repo and update reference
cd ..
git add supabase
git commit -m "chore: update supabase submodule"
git push
```

## CI/CD Considerations

Add this to your CI workflow to ensure submodules are checked out:

```yaml
- uses: actions/checkout@v4
  with:
    submodules: recursive
```

## Troubleshooting

### Submodule not updating

```bash
git submodule sync
git submodule update --init --recursive --remote
```

### Detached HEAD in submodule

```bash
cd supabase
git checkout main
git pull
```
