# EzraBot — validation locale React + Three.js

Date UTC : 2026-11-12T03:26:12.363Z

- Compilation de production locale : réussie.
- Vérification TypeScript client et serveur : réussie.
- Tests serveur avec moteurs contrôlés : 220 tests réussis, zéro échec.
- Tests navigateur Chromium : 6 tests réussis, zéro échec.
- Routes /, /react-app.js, /react-app.css, /advanced et /api/view : HTTP 200.
- Démarrage PC réel sur 127.0.0.1:4328 : moteur local annoncé ready, aucun message envoyé.
- Après validation locale, le workflow GitHub Actions a été ajouté à la demande du propriétaire : compilation TypeScript/React et tests serveur contrôlés, sans secrets fournisseur.

## Couverture navigateur

Assets React/SVG, création du canvas Three.js, navigation, brouillons après rechargement, isolation par personnage, écran de 390 px sans débordement, changement dynamique du mouvement réduit, reprise réseau avec identifiant stable, texte saisi pendant un envoi, changement de fil pendant un envoi, refus certain qui débloque la file et invitations avec positions exactes. Les tests utilisent une base temporaire et un moteur indisponible, sans appeler un fournisseur.

## Origine et limites

Le ZIP de référence ne contenait pas test/fixtures/schema-v0.sql. Cette fixture a été restaurée depuis le dépôt source local mentionné dans PROVENANCE.json. Les 220 tests serveur sont une nouvelle exécution locale.

Aucune réponse IA réelle, association HTTPS de téléphone, compilation native iPhone/Android ou interaction sur appareil physique n’a été vérifiée dans ce lot. Les fonctions avancées conservent le client historique sur /advanced ; voir README.md. Le port 4328 appartient à cette copie locale et ne modifie pas l’installation personnelle source.

## Empreintes du bundle

- `server/dist/web/react-app.js` : `057eeb038cdbfae254068ba8f7cfb67b0d4859c6a0301b13880fce455d2f8da3`
- `server/dist/web/react-app.css` : `2804f3ac348122ab4a955b5a6640249e5f3c1594117140d5d72fffbbe6994c30`
