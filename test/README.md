# Harnais de test (jsc)

Simulation du choix assisté avec 30 médecins fictifs + tests unitaires des bugs
tour/curseur, sans DOM ni Supabase.

Lancer :

    /System/Library/Frameworks/JavaScriptCore.framework/Versions/A/Helpers/jsc \
      test/pre_app.js doctors.js app.js test/sim-assisted.js

Attendu : 30/30 objectifs atteints, 0 pick non-suggéré, 0 violation Bug 2,
et les 2 tests Bug 3 à `true`.
