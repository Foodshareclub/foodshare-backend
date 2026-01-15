-- Add missing translation keys to all locales
-- This migration adds ~700 keys that exist in English but are missing from other locales

-- First, ensure English has all keys (merge missing nested structure)
UPDATE translations 
SET messages = messages || $JSON$
{
  "ChallengeReveal": {
    "accept": "Accept",
    "acceptingChallenge": "Accepting challenge...",
    "allCaughtUp": "All Caught Up!",
    "allCaughtUpDescription": "You've seen all the challenges. Shuffle the deck to go through them again!",
    "challengesRemaining": "{count} challenges remaining",
    "discoverRandom": "Discover Random",
    "keyboardHints": {"accept": "Accept", "close": "Close", "skip": "Skip"},
    "shuffle": "Shuffle",
    "shuffleAgain": "Shuffle Again",
    "skip": "Skip",
    "subtitle": "Swipe right to accept, left to skip",
    "tip": "Tip: Use arrow keys or drag to swipe through challenges"
  },
  "ForgotPassword": {
    "back_to_login": "Back to login",
    "check_email_description": "We've sent a password reset link to",
    "check_email_title": "Check your email",
    "description": "No worries! Enter your email address and we'll send you a link to reset your password.",
    "didnt_receive": "Didn't receive the email? Check your spam folder or",
    "error_generic": "Failed to send reset email. Please try again.",
    "remember_password": "Remember your password?",
    "return_to_login": "Return to login",
    "send_reset_link": "Send reset link"
  },
  "Maintenance": {
    "allSystemsOperational": "All systems operational!",
    "contact": "Need help? Contact us at support@foodshare.club",
    "description": "We are performing scheduled maintenance. Please check back soon.",
    "lastChecked": "Last checked",
    "redirecting": "Redirecting...",
    "refresh": "Refresh status",
    "serviceStatus": "Service Status"
  },
  "Reports": {
    "additionalDetails": "Additional details (optional)",
    "additionalDetailsPlaceholder": "Provide any additional context...",
    "cancel": "Cancel",
    "reasons": {"duplicate": "Duplicate", "expired": "Expired", "inappropriate": "Inappropriate", "misleading": "Misleading", "other": "Other", "safetyConcern": "Safety Concern", "spam": "Spam", "wrongLocation": "Wrong Location"},
    "report": "Report",
    "reportPost": "Report Post",
    "reportPostDescription": "Report this post by {author}",
    "reportPostDescriptionGeneric": "Report inappropriate content",
    "reportSubmitted": "Report Submitted",
    "reportSubmittedDescription": "Thank you for helping keep our community safe.",
    "selectReason": "Why are you reporting this?",
    "submitError": "Failed to submit report. Please try again.",
    "submitReport": "Submit Report",
    "submitting": "Submitting..."
  }
}
$JSON$::jsonb
WHERE locale = 'en';

-- Russian translations
UPDATE translations 
SET messages = messages || $JSON$
{
  "ChallengeReveal": {
    "accept": "Принять",
    "acceptingChallenge": "Принятие вызова...",
    "allCaughtUp": "Всё просмотрено!",
    "allCaughtUpDescription": "Вы просмотрели все вызовы. Перемешайте, чтобы пройти снова!",
    "challengesRemaining": "Осталось вызовов: {count}",
    "discoverRandom": "Случайный выбор",
    "keyboardHints": {"accept": "Принять", "close": "Закрыть", "skip": "Пропустить"},
    "shuffle": "Перемешать",
    "shuffleAgain": "Перемешать снова",
    "skip": "Пропустить",
    "subtitle": "Свайп вправо — принять, влево — пропустить",
    "tip": "Совет: используйте стрелки для навигации"
  },
  "ForgotPassword": {
    "back_to_login": "Вернуться к входу",
    "check_email_description": "Мы отправили ссылку для сброса пароля на",
    "check_email_title": "Проверьте почту",
    "description": "Не волнуйтесь! Введите email, и мы отправим ссылку для сброса пароля.",
    "didnt_receive": "Не получили письмо? Проверьте папку спам или",
    "error_generic": "Не удалось отправить письмо. Попробуйте снова.",
    "remember_password": "Вспомнили пароль?",
    "return_to_login": "Вернуться к входу",
    "send_reset_link": "Отправить ссылку"
  },
  "Maintenance": {
    "allSystemsOperational": "Все системы работают!",
    "contact": "Нужна помощь? Напишите нам: support@foodshare.club",
    "description": "Проводятся плановые работы. Пожалуйста, зайдите позже.",
    "lastChecked": "Последняя проверка",
    "redirecting": "Перенаправление...",
    "refresh": "Обновить статус",
    "serviceStatus": "Статус сервиса"
  },
  "Reports": {
    "additionalDetails": "Дополнительные детали (необязательно)",
    "additionalDetailsPlaceholder": "Опишите подробнее...",
    "cancel": "Отмена",
    "reasons": {"duplicate": "Дубликат", "expired": "Истекло", "inappropriate": "Неприемлемо", "misleading": "Вводит в заблуждение", "other": "Другое", "safetyConcern": "Проблема безопасности", "spam": "Спам", "wrongLocation": "Неверное место"},
    "report": "Пожаловаться",
    "reportPost": "Пожаловаться на пост",
    "reportPostDescription": "Пожаловаться на пост от {author}",
    "reportPostDescriptionGeneric": "Пожаловаться на неприемлемый контент",
    "reportSubmitted": "Жалоба отправлена",
    "reportSubmittedDescription": "Спасибо за помощь в поддержании безопасности сообщества.",
    "selectReason": "Почему вы жалуетесь?",
    "submitError": "Не удалось отправить жалобу. Попробуйте снова.",
    "submitReport": "Отправить жалобу",
    "submitting": "Отправка..."
  }
}
$JSON$::jsonb
WHERE locale = 'ru';

-- German translations
UPDATE translations 
SET messages = messages || $JSON$
{
  "ChallengeReveal": {
    "accept": "Annehmen",
    "acceptingChallenge": "Challenge wird angenommen...",
    "allCaughtUp": "Alles gesehen!",
    "allCaughtUpDescription": "Du hast alle Challenges gesehen. Mische, um sie erneut durchzugehen!",
    "challengesRemaining": "{count} Challenges übrig",
    "discoverRandom": "Zufällig entdecken",
    "keyboardHints": {"accept": "Annehmen", "close": "Schließen", "skip": "Überspringen"},
    "shuffle": "Mischen",
    "shuffleAgain": "Erneut mischen",
    "skip": "Überspringen",
    "subtitle": "Nach rechts wischen zum Annehmen, nach links zum Überspringen",
    "tip": "Tipp: Verwende Pfeiltasten zum Navigieren"
  },
  "ForgotPassword": {
    "back_to_login": "Zurück zur Anmeldung",
    "check_email_description": "Wir haben einen Link zum Zurücksetzen gesendet an",
    "check_email_title": "E-Mail prüfen",
    "description": "Keine Sorge! Gib deine E-Mail ein und wir senden dir einen Link zum Zurücksetzen.",
    "didnt_receive": "Keine E-Mail erhalten? Prüfe deinen Spam-Ordner oder",
    "error_generic": "E-Mail konnte nicht gesendet werden. Bitte erneut versuchen.",
    "remember_password": "Passwort wieder eingefallen?",
    "return_to_login": "Zurück zur Anmeldung",
    "send_reset_link": "Link senden"
  },
  "Maintenance": {
    "allSystemsOperational": "Alle Systeme funktionieren!",
    "contact": "Hilfe benötigt? Kontaktiere uns: support@foodshare.club",
    "description": "Wir führen Wartungsarbeiten durch. Bitte später wiederkommen.",
    "lastChecked": "Zuletzt geprüft",
    "redirecting": "Weiterleitung...",
    "refresh": "Status aktualisieren",
    "serviceStatus": "Servicestatus"
  },
  "Reports": {
    "additionalDetails": "Zusätzliche Details (optional)",
    "additionalDetailsPlaceholder": "Weitere Informationen angeben...",
    "cancel": "Abbrechen",
    "reasons": {"duplicate": "Duplikat", "expired": "Abgelaufen", "inappropriate": "Unangemessen", "misleading": "Irreführend", "other": "Sonstiges", "safetyConcern": "Sicherheitsbedenken", "spam": "Spam", "wrongLocation": "Falscher Standort"},
    "report": "Melden",
    "reportPost": "Beitrag melden",
    "reportPostDescription": "Diesen Beitrag von {author} melden",
    "reportPostDescriptionGeneric": "Unangemessenen Inhalt melden",
    "reportSubmitted": "Meldung gesendet",
    "reportSubmittedDescription": "Danke für deinen Beitrag zur Sicherheit unserer Community.",
    "selectReason": "Warum meldest du das?",
    "submitError": "Meldung konnte nicht gesendet werden. Bitte erneut versuchen.",
    "submitReport": "Meldung senden",
    "submitting": "Wird gesendet..."
  }
}
$JSON$::jsonb
WHERE locale = 'de';

-- Spanish translations
UPDATE translations 
SET messages = messages || $JSON$
{
  "ChallengeReveal": {
    "accept": "Aceptar",
    "acceptingChallenge": "Aceptando desafío...",
    "allCaughtUp": "¡Todo visto!",
    "allCaughtUpDescription": "Has visto todos los desafíos. ¡Baraja para verlos de nuevo!",
    "challengesRemaining": "{count} desafíos restantes",
    "discoverRandom": "Descubrir aleatorio",
    "keyboardHints": {"accept": "Aceptar", "close": "Cerrar", "skip": "Saltar"},
    "shuffle": "Barajar",
    "shuffleAgain": "Barajar de nuevo",
    "skip": "Saltar",
    "subtitle": "Desliza a la derecha para aceptar, a la izquierda para saltar",
    "tip": "Consejo: Usa las flechas para navegar"
  },
  "ForgotPassword": {
    "back_to_login": "Volver al inicio de sesión",
    "check_email_description": "Hemos enviado un enlace de restablecimiento a",
    "check_email_title": "Revisa tu correo",
    "description": "¡No te preocupes! Ingresa tu correo y te enviaremos un enlace para restablecer tu contraseña.",
    "didnt_receive": "¿No recibiste el correo? Revisa tu carpeta de spam o",
    "error_generic": "No se pudo enviar el correo. Por favor, intenta de nuevo.",
    "remember_password": "¿Recordaste tu contraseña?",
    "return_to_login": "Volver al inicio de sesión",
    "send_reset_link": "Enviar enlace"
  },
  "Maintenance": {
    "allSystemsOperational": "¡Todos los sistemas operativos!",
    "contact": "¿Necesitas ayuda? Contáctanos: support@foodshare.club",
    "description": "Estamos realizando mantenimiento. Por favor, vuelve pronto.",
    "lastChecked": "Última verificación",
    "redirecting": "Redirigiendo...",
    "refresh": "Actualizar estado",
    "serviceStatus": "Estado del servicio"
  },
  "Reports": {
    "additionalDetails": "Detalles adicionales (opcional)",
    "additionalDetailsPlaceholder": "Proporciona más contexto...",
    "cancel": "Cancelar",
    "reasons": {"duplicate": "Duplicado", "expired": "Expirado", "inappropriate": "Inapropiado", "misleading": "Engañoso", "other": "Otro", "safetyConcern": "Preocupación de seguridad", "spam": "Spam", "wrongLocation": "Ubicación incorrecta"},
    "report": "Reportar",
    "reportPost": "Reportar publicación",
    "reportPostDescription": "Reportar esta publicación de {author}",
    "reportPostDescriptionGeneric": "Reportar contenido inapropiado",
    "reportSubmitted": "Reporte enviado",
    "reportSubmittedDescription": "Gracias por ayudar a mantener nuestra comunidad segura.",
    "selectReason": "¿Por qué reportas esto?",
    "submitError": "No se pudo enviar el reporte. Por favor, intenta de nuevo.",
    "submitReport": "Enviar reporte",
    "submitting": "Enviando..."
  }
}
$JSON$::jsonb
WHERE locale = 'es';

-- French translations
UPDATE translations 
SET messages = messages || $JSON$
{
  "ChallengeReveal": {
    "accept": "Accepter",
    "acceptingChallenge": "Acceptation du défi...",
    "allCaughtUp": "Tout vu !",
    "allCaughtUpDescription": "Vous avez vu tous les défis. Mélangez pour les revoir !",
    "challengesRemaining": "{count} défis restants",
    "discoverRandom": "Découvrir au hasard",
    "keyboardHints": {"accept": "Accepter", "close": "Fermer", "skip": "Passer"},
    "shuffle": "Mélanger",
    "shuffleAgain": "Mélanger à nouveau",
    "skip": "Passer",
    "subtitle": "Glissez à droite pour accepter, à gauche pour passer",
    "tip": "Astuce : Utilisez les flèches pour naviguer"
  },
  "ForgotPassword": {
    "back_to_login": "Retour à la connexion",
    "check_email_description": "Nous avons envoyé un lien de réinitialisation à",
    "check_email_title": "Vérifiez votre email",
    "description": "Pas de souci ! Entrez votre email et nous vous enverrons un lien de réinitialisation.",
    "didnt_receive": "Pas reçu l'email ? Vérifiez vos spams ou",
    "error_generic": "Échec de l'envoi. Veuillez réessayer.",
    "remember_password": "Vous vous souvenez du mot de passe ?",
    "return_to_login": "Retour à la connexion",
    "send_reset_link": "Envoyer le lien"
  },
  "Maintenance": {
    "allSystemsOperational": "Tous les systèmes fonctionnent !",
    "contact": "Besoin d'aide ? Contactez-nous : support@foodshare.club",
    "description": "Maintenance en cours. Veuillez revenir bientôt.",
    "lastChecked": "Dernière vérification",
    "redirecting": "Redirection...",
    "refresh": "Actualiser le statut",
    "serviceStatus": "État du service"
  },
  "Reports": {
    "additionalDetails": "Détails supplémentaires (optionnel)",
    "additionalDetailsPlaceholder": "Fournissez plus de contexte...",
    "cancel": "Annuler",
    "reasons": {"duplicate": "Doublon", "expired": "Expiré", "inappropriate": "Inapproprié", "misleading": "Trompeur", "other": "Autre", "safetyConcern": "Problème de sécurité", "spam": "Spam", "wrongLocation": "Mauvais emplacement"},
    "report": "Signaler",
    "reportPost": "Signaler la publication",
    "reportPostDescription": "Signaler cette publication de {author}",
    "reportPostDescriptionGeneric": "Signaler un contenu inapproprié",
    "reportSubmitted": "Signalement envoyé",
    "reportSubmittedDescription": "Merci de contribuer à la sécurité de notre communauté.",
    "selectReason": "Pourquoi signalez-vous ceci ?",
    "submitError": "Échec de l'envoi. Veuillez réessayer.",
    "submitReport": "Envoyer le signalement",
    "submitting": "Envoi en cours..."
  }
}
$JSON$::jsonb
WHERE locale = 'fr';

-- For remaining locales, copy English as fallback (they can be translated later)
-- This ensures the app doesn't show raw keys
UPDATE translations 
SET messages = messages || (SELECT messages FROM translations WHERE locale = 'en') - 
    (SELECT array_agg(key) FROM jsonb_object_keys((SELECT messages FROM translations WHERE locale = translations.locale)) AS key)::text[]
WHERE locale NOT IN ('en', 'ru', 'de', 'es', 'fr');

-- Simpler approach: just merge English keys into all other locales as fallback
UPDATE translations t
SET messages = t.messages || 
  (SELECT jsonb_strip_nulls(
    jsonb_build_object(
      'ChallengeReveal', e.messages->'ChallengeReveal',
      'ForgotPassword', e.messages->'ForgotPassword', 
      'Maintenance', e.messages->'Maintenance',
      'Reports', e.messages->'Reports'
    )
  ) FROM translations e WHERE e.locale = 'en')
WHERE t.locale NOT IN ('en', 'ru', 'de', 'es', 'fr')
  AND NOT (t.messages ? 'ChallengeReveal');
