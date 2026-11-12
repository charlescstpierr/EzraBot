import assert from 'node:assert/strict';
import { test } from 'node:test';
import { looksLikeDocumentRequest } from '../web/tasks.js';

test('the local document hint recognises usual creation requests and leaves questions and chat alone', () => {
  for (const request of ['Prépare-moi un plan de déménagement', 'Rédige une lettre de motivation pour Léa', 'écris le compte rendu de la réunion', 'Fais-moi un résumé du fichier joint', 'Crée une page HTML pour le club', 'Génère une checklist de départ']) {
    assert.equal(looksLikeDocumentRequest(request), true, request);
  }
  for (const other of ['Comment rédiger une lettre ?', 'Peux-tu me rédiger une lettre ?', 'Où en est le plan ?', 'Merci pour le plan', 'Le plan me plaît, prépare la suite', 'Bonjour', 'Fais attention à toi', 'Prépare-toi', 'Rédige']) {
    assert.equal(looksLikeDocumentRequest(other), false, other);
  }
});
