import { z } from 'zod';
export function readableError(error: unknown): string {
  if (error instanceof z.ZodError) return 'Un champ est invalide ou dépasse la longueur autorisée. Vérifie le texte avant de réessayer.';
  return error instanceof Error ? error.message : 'La demande a échoué. Ton texte reste conservé.';
}
