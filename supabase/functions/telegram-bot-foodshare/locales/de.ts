/**
 * German Translations / Deutsche Übersetzungen
 */

export const de = {
  // Welcome & Start
  welcome: {
    title: "🍽️ <b>Willkommen beim FoodShare Bot!</b>",
    welcomeBack: "Willkommen zurück!",
    subtitle:
      "🌍 <i>Gemeinsam reduzieren wir Lebensmittelverschwendung und bauen Gemeinschaft auf</i>",
    whatCanDo: "<b>🎯 Was ich kann:</b>",
    shareFood:
      "🍎 <b>Essen teilen</b> - Überschüssige Lebensmittel mit unserem einfachen Formular teilen",
    findFood: "🔍 <b>Essen finden</b> - Verfügbare Lebensmittel in der Nähe entdecken",
    trackImpact: "📊 <b>Wirkung verfolgen</b> - Sehen Sie Ihren Umweltbeitrag",
    joinCommunity: "🏆 <b>Community beitreten</b> - Mit lokalen Lebensmittel-Teilern verbinden",
    quickCommands: "<b>📱 Schnellbefehle:</b>\n/share • /find • /impact • /help",
    accountReady: "Ihr Konto ist verifiziert und bereit!",
    quickActions: "Schnellaktionen",
    shareAction: "Teilen",
    shareDesc: "Überschüssige Lebensmittel posten",
    findAction: "Finden",
    findDesc: "Nach Essen suchen",
    nearbyAction: "In der Nähe",
    nearbyDesc: "Lokale Lebensmittel durchsuchen",
    impactAction: "Wirkung",
    impactDesc: "Ihre Statistiken ansehen",
    helpHint: "Verwenden Sie die Schaltflächen unten oder geben Sie /help für alle Befehle ein",
  },

  // Authentication
  auth: {
    invalidEmailTitle: "Ungültiges E-Mail-Format",
    invalidEmailMessage: "Bitte senden Sie eine gültige E-Mail-Adresse.",
    emailAlreadyLinkedTitle: "E-Mail bereits verknüpft",
    emailAlreadyLinkedMessage:
      "Diese E-Mail ist bereits mit einem anderen Telegram-Konto verknüpft.\n\nWenn dies Ihr Konto ist, wenden Sie sich bitte an den Support.",
    accountReady: "Konto bereit",
    alreadyVerified: "Ihr Konto ist bereits verifiziert und einsatzbereit!",
    signInTitle: "Anmelden mit E-Mail",
    accountFound: "Konto gefunden!",
    signInMessage: "Großartig! Wir haben Ihr FoodShare-Konto gefunden.",
    checkInbox: "Überprüfen Sie Ihren Posteingang!",
    codeEmailSent: "Wir haben einen 6-stelligen Bestätigungscode an Ihre E-Mail gesendet.",
    enterCodeToSignIn:
      "Geben Sie den Code unten ein, um sich anzumelden und Ihr Telegram-Konto zu verbinden.",
    afterSignIn: "Nach der Anmeldung können Sie",
    accessPosts: "Auf alle Ihre Lebensmittelbeiträge zugreifen",
    manageMessages: "Nachrichten über Telegram verwalten",
    trackImpact: "Ihre Wirkung unterwegs verfolgen",
    codeExpires: "Code läuft in 15 Minuten ab",
    resendHint: "Geben Sie /resend ein, wenn Sie ihn nicht erhalten haben",
    emailDeliveryFailedTitle: "E-Mail-Zustellung fehlgeschlagen",
    emailDeliveryFailedMessage:
      "Wir konnten die Bestätigungs-E-Mail nicht senden.\n\nBitte versuchen Sie es in einem Moment erneut oder wenden Sie sich an den Support.",
    completeRegistrationTitle: "Registrierung abschließen",
    completeRegistrationMessage:
      "Wir haben Ihr FoodShare-Konto gefunden, das eine Bestätigung benötigt.",
    codeEmailSentComplete:
      "Wir haben einen 6-stelligen Bestätigungscode gesendet, um Ihre Registrierung abzuschließen.",
    enterCodeToVerify:
      "Geben Sie den Code unten ein, um zu bestätigen und Ihr Telegram-Konto zu verknüpfen.",
    afterVerification: "Nach der Bestätigung können Sie",
    shareFood: "Überschüssige Lebensmittel teilen",
    findFood: "Lebensmittel in der Nähe finden",
    registrationFailedTitle: "Registrierung fehlgeschlagen",
    registrationFailedMessage:
      "Wir konnten Ihr Konto nicht erstellen.\n\nBitte versuchen Sie es erneut oder wenden Sie sich an den Support.",
    verifyEmailTitle: "E-Mail bestätigen",
    accountCreated: "Konto erstellt!",
    codeSentTo: "Ein 6-stelliger Code wurde gesendet an:",
    joinRevolution: "Treten Sie der Lebensmittel-Sharing-Revolution bei!",
    reduceWaste: "Lebensmittelverschwendung reduzieren",
    getStarted: "Loslegen",
    newUser: "Neuer Benutzer?",
    sendEmailToRegister: "Senden Sie Ihre E-Mail zur Registrierung",
    haveAccount: "Haben Sie bereits ein Konto?",
    sendEmailToSignIn: "Senden Sie Ihre registrierte E-Mail zum Anmelden",
    selectLanguage: "Wählen Sie Ihre Sprache",
  },

  // Language
  language: {
    changed: "Sprache geändert",
    selectedLanguage: "Ausgewählte Sprache",
    continueMessage: "Lassen Sie uns mit Ihrer Registrierung fortfahren!",
    selectTitle: "Sprache wählen",
    selectMessage: "Wählen Sie Ihre bevorzugte Sprache für den Bot:",
  },

  // Share Food
  share: {
    title: "🍎 <b>Essen mit FoodShare teilen</b>",
    chooseMethod: "Wählen Sie, wie Sie Ihr Essen veröffentlichen möchten:",
    webFormRecommended: "🌟 <b>Empfohlen:</b> Nutzen Sie unser schönes Web-Formular",
    chatAlternative: "💬 <b>Alternative:</b> Über Chat-Nachrichten teilen",
    webFormFaster: "<i>Das Web-Formular ist schneller und einfacher!</i>",
    openFormButton: "🍎 Formular öffnen",
    useChatButton: "📱 Chat verwenden",

    // Chat flow
    step1Photo:
      "📸 <b>Schritt 1 von 3: Foto</b>\n\nSenden Sie mir ein Foto von dem Essen, das Sie teilen möchten.\n\n💡 <i>Tipp: Gute Fotos wecken mehr Interesse!</i>\n\nGeben Sie /cancel ein zum Abbrechen",
    step2Description:
      "✅ <b>Foto erhalten!</b>\n\n📝 <b>Schritt 2 von 3: Beschreibung</b>\n\nErzählen Sie den Leuten von Ihrem Essen:\n• Was ist es?\n• Wie viel?\n• Besondere Hinweise?\n\n━━━━━━━━━━━━━━━━━━━━\n\n<b>Beispiel:</b>\n<i>Frische Äpfel aus meinem Garten\n\nEtwa 2kg Bio-Äpfel.\nPerfekt zum Essen oder Backen.\nHeute bis 18 Uhr zur Abholung verfügbar.</i>\n\n━━━━━━━━━━━━━━━━━━━━\n\nGeben Sie Ihre Beschreibung ein:",
    step3Location:
      '✅ <b>Beschreibung gespeichert!</b>\n\n📍 <b>Schritt 3 von 3: Standort</b>\n\nWo können die Leute das abholen?\n\n━━━━━━━━━━━━━━━━━━━━\n\n<b>Optionen:</b>\n\n📝 <b>Adresse eingeben:</b>\n<i>"Prag 1, Wenzelsplatz"</i>\n\n📱 <b>GPS teilen:</b>\n<i>Verwenden Sie die Standort-Schaltfläche von Telegram</i>\n\n⏭️ <b>Überspringen:</b>\n<i>Geben Sie "skip" ein, um Ihren Profilstandort zu verwenden</i>\n\n━━━━━━━━━━━━━━━━━━━━\n\nGeben Sie Ihren Standort ein:',
    lookingUpLocation: "📍 Suche Standort...",
    locationNotFound:
      '❌ Standort nicht gefunden. Bitte versuchen Sie:\n• Eine genauere Adresse\n• Stadtname (z.B. "Prag")\n• Geben Sie "skip" ein, um Ihren Profilstandort zu verwenden\n• Oder /cancel zum Abbrechen',
    success:
      '🎉 <b>Essen erfolgreich geteilt!</b>\n\nIhr Essen ist jetzt für die Community verfügbar.\n\n🔗 <a href="{url}">Ihren Beitrag ansehen</a>{locationNote}\n\nDanke, dass Sie Lebensmittelverschwendung reduzieren! 🌍',
    noLocationNote:
      "\n\n⚠️ <i>Hinweis: Kein Standort festgelegt. Fügen Sie einen Standort auf dem Handy oder der Website hinzu für bessere Sichtbarkeit.</i>",
    linkAccountFirst:
      '❌ Bitte verknüpfen Sie zuerst Ihr Telegram-Konto auf FoodShare:\n🔗 <a href="{url}">Konto verknüpfen</a>',
  },

  // Find Food
  find: {
    title: "🔍 <b>{count} Lebensmittel gefunden:</b>",
    noFood:
      "Momentan keine Lebensmittel verfügbar. Seien Sie der Erste, der teilt! Verwenden Sie /share",
    noMatch: 'Keine Lebensmittel gefunden für "{query}". Versuchen Sie eine andere Suche!',
  },

  // Profile & Impact
  profile: {
    title: "👤 <b>Ihr Profil</b>",
    manageOnWebsite:
      'Verwalten Sie Ihr Profil auf der Website:\n🔗 <a href="{url}">Profil öffnen</a>',
  },

  impact: {
    title: "🌍 <b>Ihre Umweltwirkung</b>",
    foodShared: "🍎 Geteiltes Essen: {count} Artikel",
    foodClaimed: "🎯 Erhaltenes Essen: {count} Artikel",
    wastePrevented: "♻️ Vermiedener Abfall: {kg}kg",
    co2Saved: "🌱 CO2 gespart: {kg}kg",
    moneySaved: "💰 Wert gespart: ${amount}",
    memberSince: "📅 Mitglied seit: {date}",
    badges: "🏅 <b>Abzeichen:</b> {badges}",
  },

  // Stats & Leaderboard
  stats: {
    title: "📊 <b>Ihre Statistiken</b>",
    messages: "💬 Nachrichten: {count}",
    commands: "⚡ Befehle: {count}",
    lastActive: "🕐 Zuletzt aktiv: {date}",
    noStatsYet:
      "📊 Noch keine Statistiken gefunden. Beginnen Sie Essen zu teilen, um Ihre Statistiken aufzubauen!",
    linkAccountFirst:
      '❌ Bitte verknüpfen Sie zuerst Ihr Telegram-Konto auf FoodShare:\n🔗 <a href="{url}">Konto verknüpfen</a>',
  },

  leaderboard: {
    title: "🏆 <b>Top-Beitragende</b>",
    noData: "🏆 Noch keine Bestenlisten-Daten verfügbar. Seien Sie der Erste, der Essen teilt!",
  },

  // Help
  help: {
    title: "🍽️ <b>FoodShare Bot - Alle Befehle</b>",
    foodSharing: "<b>🍎 Essen teilen:</b>",
    shareCmd: "/share - Überschüssiges Essen teilen",
    findCmd: "/find [Artikel] - Nach Essen suchen",
    nearbyCmd: "/nearby - Essen in Ihrer Nähe",
    profileSection: "<b>👤 Profil:</b>",
    profileCmd: "/profile - Profil ansehen/bearbeiten",
    impactCmd: "/impact - Ihre Umweltwirkung",
    communitySection: "<b>📊 Community:</b>",
    statsCmd: "/stats - Ihre Aktivitätsstatistiken",
    leaderboardCmd: "/leaderboard - Top-Beitragende",
    otherSection: "<b>ℹ️ Sonstiges:</b>",
    languageCmd: "/language - Sprache ändern",
    helpCmd: "/help - Diese Nachricht anzeigen",
    cancelCmd: "/cancel - Aktuelle Aktion abbrechen",
    tip: "<i>Tipp: Verwenden Sie die Schaltflächen unten für schnelle Aktionen!</i>",
  },

  // Common
  common: {
    example: "Beispiel",
    email: "E-Mail",
    back: "« Zurück",
    cancel: "❌ Aktion abgebrochen.",
    error: "❌ Fehler: {message}",
    comingSoon:
      "📍 <b>Essen in der Nähe</b>\n\nDiese Funktion kommt bald! Verwenden Sie /find, um alle verfügbaren Lebensmittel zu sehen.",
  },

  // Buttons
  buttons: {
    shareFood: "Essen teilen",
    findFood: "Essen finden",
    nearbyFood: "Essen in der Nähe",
    myProfile: "Mein Profil",
    myStats: "Meine Wirkung",
    leaderboard: "Bestenliste",
    openFoodShare: "FoodShare öffnen",
  },

  // Menu (persistent keyboard)
  menu: {
    shareFood: "🍎 Teilen",
    findFood: "🔍 Finden",
    nearby: "📍 Nähe",
    profile: "👤 Profil",
    impact: "🌍 Wirkung",
    stats: "📊 Stats",
    help: "❓ Hilfe",
    language: "🌐 Sprache",
    leaderboard: "🏆 Top",
  },
};
