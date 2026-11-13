# The deployment configuration lives at openbot/.env.
link_env() {
  ln -sfn openbot/.env .env
}
