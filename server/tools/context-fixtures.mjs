export function contextFixtures() {
  const history = Array.from({ length: 12 }, (_, i) => ({ role: i % 2 ? 'assistant' : 'user', text: `Échange ${i}. ${'Une note de projet ancienne, déjà traitée. '.repeat(45)}` }));
  return [
    { name: 'question-courte-apres-historique-long', context: { bot: { id: 'mino', name: 'Mino', title: '' }, memories: [], history, request: { text: 'Comment nommer une variable qui compte les commandes ?', attachments: [] } } },
    { name: 'piece-jointe-et-memoire', context: { bot: { id: 'mino', name: 'Mino', title: '' }, memories: [{ id: 'm1', text: 'Répondre en français.' }], history: [], request: { text: 'Résume ce document en trois points.', attachments: [{ name: 'notes.txt', text: 'Donnée importante à garder intégralement. '.repeat(200) }] } } },
  ];
}
