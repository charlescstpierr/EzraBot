# Apports retenus pour EzraBot

Ce lot complète les parcours React qui existaient déjà dans le serveur et le client de référence. Le serveur PC et ses autorisations restent la source de vérité.

## Références inspectées

- [Rakazo](https://github.com/elie222/rakazo/tree/2d28de336440c73bbda7dd2c02f63fef370d335f), version `2d28de3`, licence Apache-2.0.
- [Grok Ship](https://github.com/kunchenguid/grok-ship/tree/87ef9325de1e943c98a7726fc1f6f95b608644e6), version `87ef932`, licence MIT. Son README indique qu’un autre template le remplace.

Leur code n’a pas été intégré au produit. Les mécanismes retenus sont réimplémentés avec les contrats et les modules existants d’EzraBot.

## Mécanismes retenus

La recherche de Rakazo inspire la navigation entre les résultats. EzraBot utilise sa recherche locale existante, qui couvre tous les messages reçus et les versions courantes des documents. Une cible ouvre son message ou sa version précise.

La lecture dédiée et les activités repliables de Rakazo inspirent les panneaux de résultats et de mission. Les activités proviennent des événements reçus. Le lecteur HTML utilise la route isolée du serveur. Une absence de compteur reste une absence, jamais zéro.

Le contrôle de révision de Rakazo inspire `memory.update.baseUpdatedAt`. Le serveur refuse une édition périmée sans toucher au souvenir. Les jetons restent strictement croissants même si l’horloge recule. Les clients anciens qui omettent cette base conservent leur comportement.

Les procédures de Grok Ship inspirent la présentation des décisions et des preuves. Le serveur EzraBot fournit déjà les décisions appliquées ou refusées, les étapes enfants, les budgets communs et les revues. Le client les présente sans accorder de nouvelle autorisation.

## Fonctions écartées de ce lot

La fusion et la fermeture automatiques de PR sont incompatibles avec les règles du propriétaire. Aucun agent ne peut les déclencher.

Un nouveau mode d’enquête en lecture seule modifierait les protocoles, les décisions du moteur et les clients natifs. Le mode direct ou coordonné actuel reste en place. Les responsables et revues gardent leurs restrictions existantes.

Le triage externe, les connecteurs, la recherche web, l’OCR, la voix, les notifications et les routines restent hors du périmètre documenté. Ils demandent leurs propres accès, validations et reçus. Aucun fournisseur payant ni service externe n’est ajouté.

## Limites de vérification

Les recettes automatiques utilisent des bases temporaires et des données synthétiques. Les états qui nécessitent un moteur en cours utilisent des fixtures explicitement nommées dans les tests. Ces fixtures prouvent le comportement de l’interface, pas une exécution chez un fournisseur.

Les essais physiques iPhone et Android, les certificats privés, l’association par téléphone et la distribution native ne sont pas validés par ces recettes web. Le client Expo et le client de référence sont conservés.
