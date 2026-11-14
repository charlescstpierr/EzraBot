# Contrat préparatoire Honcho

Le ticket #26 prépare le raccord choisi dans #15 et suivi dans #16. Aucun appel Honcho, stockage, migration ou raccord au chat n'est livré. Honcho reste la seule mémoire longue prévue.

## Port interne

`server/src/honcho-contract.ts` définit `HonchoPort`. Ses opérations décrivent les besoins d'EzraBot, sans correspondance présumée avec une API Honcho. `recall` retourne des données inconnues à valider. `ingest` reçoit une source originale autorisée et une liaison explicite projet, workspace et génération. `requestWithdrawal` demande un retrait. Un résultat `acknowledged` est un acquittement, sans preuve de retrait. Une capacité absente ou une issue inconnue reste `unsupported` ou `uncertain`.

Les origines admises sont un message local identifié ou une déclaration locale enregistrée. Une déclaration du panneau mémoire ne devient pas un faux message. Le module accepte seulement des références d'originaux. Il ne traite ni profils ni inférences ni synthèses libres du fournisseur.

## Contrôle local

`selectHonchoRecall` est une fonction pure. Son entrée contient la portée courante, la requête initiale, la réponse distante, les originaux relus et les exclusions courantes. L'appelant est l'autorité locale. Les originaux et la portée ne doivent jamais venir du fournisseur ou du modèle.

La fonction refuse un schéma invalide, une portée suspendue, un autre projet ou workspace, une génération périmée, une indisponibilité ou des identifiants locaux ambigus. Elle écarte les références absentes, exclues, remplacées, de mauvaise révision ou d'un autre projet. Le texte retourné vient uniquement de l'original autorisé. Une origine et une révision accompagnent chaque extrait.

Une correction marque l'ancienne source `corrected`, conserve son lien `replacedBy` et avance la génération. Les déclarations actuelles et les autres sources restent utilisables. Un oubli avance aussi la génération, conserve les exclusions et place la portée en `withdrawal_pending`. Sans preuve suffisante, elle reste `withdrawal_unverified`. `reset_pending` suspend le rappel pendant la préparation d'un workspace différent et vide. Aucun ACK ne change ces états dans ce module. Aucune fonction ne prétend vérifier la purge fournisseur.

Chaque requête admet de 1 à 10 extraits et de 1 à 4 000 unités UTF-16 au total pour leurs textes. Une réponse contient au plus 100 références. Les extraits suivent leur ordre, sans doublon. La coupe conserve les paires UTF-16 et signale `truncated`. Les métadonnées ne sont pas comprises dans cette enveloppe de texte. Ce plafond reste distinct du budget des derniers tours.

## Raccord restant

L'admission commune L01a précède tout appel réel. Le futur adaptateur doit prouver sur une instance synthétique choisie l'isolation, les correspondances d'identifiants, la relecture des sources et les capacités réellement utilisées. Il doit valider les résultats d'écriture avec `HonchoWriteResultSchema`. Les garanties de retrait ne sont pas établies par ces tests locaux.

L'intégration doit relire droits, originaux, exclusions et génération avant composition, puis de nouveau avant publication. La sélection ne réserve rien et ne protège pas seule une réponse déjà composée. Une génération changée invalide aussi cette réponse. Les transitions durables, la correction, le retrait, la confirmation d'un workspace vide et la migration volontaire restent à construire. Le reset ne réimporte aucune ancienne source automatiquement. Les exclusions subsistent, y compris après restauration.

Les tests `server/test/honcho-contract.test.ts` utilisent des sources synthétiques et la vraie fonction pure. Ils ne prouvent aucune capacité fournisseur. Aucun profil dérivé local n'est créé.
