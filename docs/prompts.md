### Secret Management

- We used the Supabase cloud backend pretty much all the secrets were set up in that cloud: 
    - For both web and mobile app repos we already set up the initial Supabase secrets in the GitHub Actions secrets just to be able to access the Supabase Vault and the Supabase edge function secrets. 
    - Since we use self-hosted Supabase now I wanna make sure we use the same approach — establish parity between the cloud and self-hosted Supabase. It's the secure and very convenient way to manage secrets.
    - Check out our backend repo Users/organic/dev/work/foodshare/foodshare-backend, bring changes to the repo, then commit and push them respectively via the CI/CD pipeline.
    - Again, the experience must match the Supabase cloud, but with our self-hosted stack. 


