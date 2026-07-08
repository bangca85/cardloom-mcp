export interface SecretPattern {
  name: string;
  regex: RegExp;
}

export const SECRET_PATTERNS: SecretPattern[] = [
  { name: 'OpenAI/Anthropic API key', regex: /sk-[a-zA-Z0-9_-]{20,}/ },
  { name: 'AWS Access Key', regex: /AKIA[0-9A-Z]{16}/ },
  { name: 'GitHub Personal Access Token', regex: /ghp_[a-zA-Z0-9]{36}/ },
  { name: 'GitHub OAuth Token', regex: /gho_[a-zA-Z0-9]{36}/ },
  { name: 'Bearer Token', regex: /Bearer\s+eyJ[a-zA-Z0-9_-]+\.eyJ[a-zA-Z0-9_-]+/ },
  { name: 'PostgreSQL connection string', regex: /postgres(?:ql)?:\/\/[^\s]+:[^\s]+@/ },
  { name: 'MongoDB connection string', regex: /mongodb(?:\+srv)?:\/\/[^\s]+:[^\s]+@/ },
  { name: 'MySQL connection string', regex: /mysql:\/\/[^\s]+:[^\s]+@/ },
  { name: 'Generic secret assignment', regex: /(?:API_KEY|SECRET|PASSWORD|TOKEN|PRIVATE_KEY)\s*=\s*[^\s]{8,}/ },
];
