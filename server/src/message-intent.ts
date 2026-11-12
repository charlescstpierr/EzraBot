export function requestsBackgroundResult(text: string): boolean {
  let normalized = text.trim();
  const prefix = /^(?:s[’']il te plaît[,.]?\s*|peux[- ]tu\s+|pourrais[- ]tu\s+|est-ce que tu peux\s+|can you\s+|please\s+)/iu;
  while (prefix.test(normalized)) normalized = normalized.replace(prefix, '');
  return /^(?:me\s+)?(?:prépar(?:e|er)|cré(?:e|er)|écri(?:s|re)|rédig(?:e|er)|gén(?:ère|érer)|construi(?:s|re)|fai(?:s|re|t)|build|create|write|draft|prepare)(?![\p{L}\p{N}])/iu.test(normalized)
    && /(?<![\p{L}\p{N}])(?:plan|rapport|lettre|article|page|html|site|document|budget|présentation|guide|liste|programme|application|app|résumé|checklist|report|website|letter)s?(?![\p{L}\p{N}])/iu.test(normalized);
}
