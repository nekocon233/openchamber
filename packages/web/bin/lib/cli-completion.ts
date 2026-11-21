import { isString } from '../../server/lib/shared/object-guards.js';

export function generateCompletionScript(shell: string | null | undefined) {
  const normalized = isString(shell) ? shell.trim().toLowerCase() : '';

  if (normalized === 'bash') {
    return `# Bash completion for openchamber tunnel
# Add to ~/.bashrc: eval "$(openchamber tunnel completion bash)"
_openchamber_tunnel() {
  local cur prev commands tunnel_commands profile_commands common_flags start_flags profile_add_flags
  COMPREPLY=()
  cur="\${COMP_WORDS[COMP_CWORD]}"
  prev="\${COMP_WORDS[COMP_CWORD-1]}"

    commands="serve stop restart status schedule session memory models projects tunnel logs update"
  tunnel_commands="help providers ready doctor status start stop profile completion"
  profile_commands="list show add remove"
  common_flags="--port --foreground --no-daemon --json --all --force --help --version --plain --quiet"
  start_flags="--provider --mode --profile --config --token --token-file --token-stdin --hostname --public-url --custom-domain --frps-address --frps-port --remote-port --connect-ttl --session-ttl --qr --no-qr --dry-run"
  profile_add_flags="--provider --mode --name --token --token-file --token-stdin --hostname --public-url --custom-domain --frps-address --frps-port --remote-port --force --dry-run"

  if [[ \${COMP_CWORD} -eq 1 ]]; then
    COMPREPLY=( $(compgen -W "\${commands}" -- "\${cur}") )
    return 0
  fi

  if [[ "\${COMP_WORDS[1]}" == "memory" && \${COMP_CWORD} -eq 2 ]]; then
    COMPREPLY=( $(compgen -W "status list read save delete connect disconnect" -- "\${cur}") )
    return 0
  fi
  if [[ "\${COMP_WORDS[1]}" == "tunnel" ]]; then
    if [[ \${COMP_CWORD} -eq 2 ]]; then
      COMPREPLY=( $(compgen -W "\${tunnel_commands}" -- "\${cur}") )
      return 0
    fi
    if [[ "\${COMP_WORDS[2]}" == "profile" && \${COMP_CWORD} -eq 3 ]]; then
      COMPREPLY=( $(compgen -W "\${profile_commands}" -- "\${cur}") )
      return 0
    fi
    if [[ "\${COMP_WORDS[2]}" == "completion" && \${COMP_CWORD} -eq 3 ]]; then
      COMPREPLY=( $(compgen -W "bash zsh fish" -- "\${cur}") )
      return 0
    fi
    if [[ "\${COMP_WORDS[2]}" == "start" ]]; then
      COMPREPLY=( $(compgen -W "\${start_flags} \${common_flags}" -- "\${cur}") )
      return 0
    fi
    if [[ "\${COMP_WORDS[2]}" == "profile" && "\${COMP_WORDS[3]}" == "add" ]]; then
      COMPREPLY=( $(compgen -W "\${profile_add_flags} \${common_flags}" -- "\${cur}") )
      return 0
    fi
    COMPREPLY=( $(compgen -W "\${common_flags}" -- "\${cur}") )
    return 0
  fi

  COMPREPLY=( $(compgen -W "\${common_flags}" -- "\${cur}") )
  return 0
}
complete -F _openchamber_tunnel openchamber
`;
  }

  if (normalized === 'zsh') {
    return `#compdef openchamber
# Zsh completion for openchamber tunnel
# Add to ~/.zshrc: eval "$(openchamber tunnel completion zsh)"

_openchamber() {
  local -a commands tunnel_commands profile_commands

  commands=(
    'serve:Start the web server'
    'stop:Stop running instance(s)'
    'restart:Stop and start the server'
    'status:Show server status'
    'schedule:Manage scheduled tasks'
    'session:Create sessions'
    'memory:Share knowledge and connect native CLIs'
    'models:Show default and favorite models'
    'projects:Show configured projects and IDs'
    'tunnel:Tunnel lifecycle commands'
    'logs:Tail OpenChamber logs'
    'update:Check for and install updates'
  )

  tunnel_commands=(
    'help:Show tunnel help'
    'providers:Show available providers'
    'ready:Check tunnel readiness'
    'doctor:Run tunnel diagnostics'
    'status:Show tunnel status'
    'start:Start a tunnel'
    'stop:Stop active tunnel'
    'profile:Manage saved profiles'
    'completion:Generate shell completion'
  )

  profile_commands=(
    'list:List profiles'
    'show:Show profile details'
    'add:Add a profile'
    'remove:Remove a profile'
  )

  _arguments -C \\
    '--custom-domain[FRPC HTTP-vhost custom domain]:hostname:' \\
    '--public-url[Externally TLS-terminated HTTPS origin for FRPC TCP]:url:' \\
    '--force[Confirm destructive or multi-target operation]' \\
    '1:command:->command' \\
    '*::arg:->args'

  case $state in
    command)
      _describe 'command' commands
      ;;
    args)
      case $words[1] in
        memory)
          _values 'memory command' status list read save delete connect disconnect
          ;;
        tunnel)
          if (( CURRENT == 2 )); then
            _describe 'tunnel command' tunnel_commands
          elif [[ $words[2] == "profile" ]] && (( CURRENT == 3 )); then
            _describe 'profile action' profile_commands
          elif [[ $words[2] == "completion" ]] && (( CURRENT == 3 )); then
            _values 'shell' bash zsh fish
          fi
          ;;
      esac
      ;;
  esac
}

compdef _openchamber openchamber
`;
  }

  if (normalized === 'fish') {
    return `# Fish completion for openchamber tunnel
# Save to ~/.config/fish/completions/openchamber.fish

complete -c openchamber -n '__fish_use_subcommand' -a 'serve' -d 'Start the web server'
complete -c openchamber -n '__fish_seen_subcommand_from serve' -l foreground -d 'Run in foreground (for systemd/process managers)'
complete -c openchamber -n '__fish_seen_subcommand_from serve' -l no-daemon -d 'Run in foreground (alias for --foreground)'
complete -c openchamber -n '__fish_use_subcommand' -a 'stop' -d 'Stop running instance(s)'
complete -c openchamber -n '__fish_use_subcommand' -a 'restart' -d 'Stop and start the server'
complete -c openchamber -n '__fish_use_subcommand' -a 'status' -d 'Show server status'
complete -c openchamber -n '__fish_use_subcommand' -a 'tunnel' -d 'Tunnel lifecycle commands'
complete -c openchamber -n '__fish_use_subcommand' -a 'memory' -d 'Shared memory and native CLIs'
complete -c openchamber -n '__fish_seen_subcommand_from memory' -a 'status list read save delete connect disconnect'
complete -c openchamber -n '__fish_use_subcommand' -a 'logs' -d 'Tail logs'
complete -c openchamber -n '__fish_use_subcommand' -a 'update' -d 'Check for updates'

complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and not __fish_seen_subcommand_from help providers ready doctor status start stop profile completion' -a 'help' -d 'Show tunnel help'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and not __fish_seen_subcommand_from help providers ready doctor status start stop profile completion' -a 'providers' -d 'Show providers'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and not __fish_seen_subcommand_from help providers ready doctor status start stop profile completion' -a 'ready' -d 'Check readiness'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and not __fish_seen_subcommand_from help providers ready doctor status start stop profile completion' -a 'doctor' -d 'Run diagnostics'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and not __fish_seen_subcommand_from help providers ready doctor status start stop profile completion' -a 'status' -d 'Show tunnel status'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and not __fish_seen_subcommand_from help providers ready doctor status start stop profile completion' -a 'start' -d 'Start a tunnel'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and not __fish_seen_subcommand_from help providers ready doctor status start stop profile completion' -a 'stop' -d 'Stop tunnel'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and not __fish_seen_subcommand_from help providers ready doctor status start stop profile completion' -a 'profile' -d 'Manage profiles'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and not __fish_seen_subcommand_from help providers ready doctor status start stop profile completion' -a 'completion' -d 'Generate completions'

complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from start' -l provider -d 'Provider id'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from start' -l mode -d 'Tunnel mode'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from start' -l profile -d 'Profile name'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from start' -l config -d 'Config path'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from start' -l token -d 'Token'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from start' -l token-file -d 'Token file path'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from start' -l token-stdin -d 'Read token from stdin'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from start' -l hostname -d 'Public hostname'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from start' -l public-url -d 'Externally TLS-terminated HTTPS origin for FRPC TCP'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from start' -l custom-domain -d 'FRPC HTTP-vhost custom domain'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from start' -l frps-address -d 'FRPS server address'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from start' -l frps-port -d 'FRPS control port'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from start' -l remote-port -d 'FRPS remote mapping port'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from start' -l dry-run -d 'Validate without applying'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from start' -l qr -d 'Show QR code'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from stop' -l force -d 'Confirm stop on all instances'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from profile; and __fish_seen_subcommand_from add' -l custom-domain -d 'FRPC HTTP-vhost custom domain'
complete -c openchamber -n '__fish_seen_subcommand_from tunnel; and __fish_seen_subcommand_from profile; and __fish_seen_subcommand_from add' -l public-url -d 'Externally TLS-terminated HTTPS origin for FRPC TCP'
`;
  }

  return null;
}
