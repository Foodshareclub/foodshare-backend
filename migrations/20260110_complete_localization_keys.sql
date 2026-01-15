-- Migration: Add complete admin, settings, and 2FA translation keys
-- This migration adds all missing translation keys identified during the localization audit
-- 243 keys for admin.* and settings.* namespaces

-- Helper function to deep merge JSONB objects
CREATE OR REPLACE FUNCTION deep_merge_jsonb(base jsonb, overlay jsonb)
RETURNS jsonb
LANGUAGE sql
IMMUTABLE
AS $$
  SELECT
    CASE
      WHEN jsonb_typeof(base) = 'object' AND jsonb_typeof(overlay) = 'object' THEN
        (SELECT jsonb_object_agg(
          COALESCE(bo.key, oo.key),
          CASE
            WHEN bo.value IS NULL THEN oo.value
            WHEN oo.value IS NULL THEN bo.value
            WHEN jsonb_typeof(bo.value) = 'object' AND jsonb_typeof(oo.value) = 'object'
              THEN deep_merge_jsonb(bo.value, oo.value)
            ELSE oo.value
          END
        )
        FROM jsonb_each(base) bo
        FULL OUTER JOIN jsonb_each(overlay) oo ON bo.key = oo.key)
      ELSE overlay
    END
$$;

-- English translations for admin namespace
DO $$
DECLARE
  admin_keys jsonb := '{
    "access_denied": "Access Denied",
    "access_denied_message": "You do not have permission to access this area.",
    "account_info": "Account Info",
    "action": "Action",
    "actions": {
      "assign_role": "Assign Role",
      "ban_user": "Ban User",
      "delete_comment": "Delete Comment",
      "delete_post": "Delete Post",
      "edit_user": "Edit User",
      "export_data": "Export Data",
      "restore_post": "Restore Post",
      "revoke_role": "Revoke Role",
      "unban_user": "Unban User",
      "view_audit_log": "View Audit Log",
      "view_user": "View User"
    },
    "all_roles_assigned": "All roles assigned",
    "assign_role": "Assign Role",
    "assigned_roles": "Assigned Roles",
    "audit_log": "Audit Log",
    "audit_logs_empty": "No audit logs found",
    "ban_action": "Ban Action",
    "ban_confirmation_message": "Are you sure you want to ban this user?",
    "ban_reason_placeholder": "Enter reason for ban...",
    "ban_user": "Ban User",
    "banned": "Banned",
    "content_active": "Active Content",
    "content_details": "Content Details",
    "dashboard": "Dashboard",
    "flag_score": "Flag Score",
    "health": "Health",
    "high_priority": "High Priority",
    "joined": "Joined",
    "last_active": "Last Active",
    "last_seen": "Last Seen",
    "manage_users": "Manage Users",
    "moderation": "Moderation",
    "moderation_priority": {
      "critical": "Critical",
      "high": "High",
      "low": "Low",
      "medium": "Medium"
    },
    "moderation_queue_empty": "No items in moderation queue",
    "moderation_resolution": {
      "approved": "Approved",
      "edited": "Edited",
      "escalated": "Escalated",
      "no_action": "No Action Required",
      "removed": "Removed",
      "user_banned": "User Banned",
      "warning_issued": "Warning Issued"
    },
    "moderation_status": {
      "dismissed": "Dismissed",
      "escalated": "Escalated",
      "in_review": "In Review",
      "pending": "Pending",
      "resolved": "Resolved"
    },
    "new_posts": "New Posts",
    "new_users": "New Users",
    "no_audit_logs": "No audit logs",
    "no_items": "No items",
    "no_roles": "No roles assigned",
    "no_users_found": "No users found",
    "notes": "Notes",
    "notes_placeholder": "Add notes...",
    "platform_health": "Platform Health",
    "priority": "Priority",
    "queue_type": "Queue Type",
    "quick_actions": "Quick Actions",
    "reason": "Reason",
    "reported_by": "Reported By",
    "reports_queue": "Reports Queue",
    "resolution": "Resolution",
    "resolve_item": "Resolve Item",
    "resource": {
      "comment": "Comment",
      "post": "Post",
      "report": "Report",
      "role": "Role",
      "system": "System",
      "user": "User"
    },
    "role": "Role",
    "search_users": "Search users...",
    "sort": {
      "alphabetical": "Alphabetical",
      "last_active": "Last Active",
      "newest": "Newest",
      "oldest": "Oldest"
    },
    "stats": {
      "active_posts": "Active Posts",
      "active_users": "Active Users",
      "messages": "Messages",
      "pending_reports": "Pending Reports",
      "total_posts": "Total Posts",
      "total_users": "Total Users"
    },
    "submit_resolution": "Submit Resolution",
    "title": "Admin",
    "todays_activity": "Today''s Activity",
    "try_adjusting_search": "Try adjusting your search criteria",
    "type_label": "Type",
    "unban_user": "Unban User",
    "unknown_admin": "Unknown Admin",
    "user_activity": "User Activity",
    "user_details": "User Details",
    "user_id": "User ID",
    "user_status": {
      "active": "Active",
      "all": "All",
      "banned": "Banned",
      "inactive": "Inactive"
    },
    "users": "Users",
    "verified": "Verified",
    "view_reports": "View Reports"
  }'::jsonb;

  settings_keys jsonb := '{
    "account": "Account",
    "account_type": "Account Type",
    "admin": "Admin",
    "change_password": "Change Password",
    "change_password_hint": "Enter your current password and choose a new one",
    "change_photo": "Change Photo",
    "changes_saved": "Changes saved",
    "changing_password": "Changing password...",
    "choose_from_library": "Choose from Library",
    "choose_theme": "Choose Theme",
    "confirm_new_password": "Confirm New Password",
    "confirm_new_password_placeholder": "Confirm your new password",
    "current_password": "Current Password",
    "delete_account": "Delete Account",
    "delete_account_confirm": "This action cannot be undone. Are you sure?",
    "delete_forever": "Delete Forever",
    "deleting_account": "Deleting account...",
    "deletion_failed": "Account deletion failed",
    "display_name": "Display Name",
    "edit_profile": "Edit Profile",
    "email": "Email",
    "enter_current_password": "Enter your current password",
    "enter_new_password": "Enter your new password",
    "enter_your_name": "Enter your name",
    "location_services": "Location Services",
    "login_security": "Login & Security",
    "member": "Member",
    "member_since": "Member Since",
    "mfa": {
      "about_2fa": "About Two-Factor Authentication",
      "active_factors": "Active Factors",
      "authenticator_app": "Authenticator App",
      "back_to_qr": "Back to QR Code",
      "cant_scan": "Can''t scan the code?",
      "checking_status": "Checking status...",
      "code_refresh": "Code will refresh in {seconds}s",
      "compatible_apps": "Compatible Apps",
      "compatible_apps_desc": "Google Authenticator, Authy, 1Password, Microsoft Authenticator",
      "complete_setup": "Complete Setup",
      "complete_verification": "Complete Verification",
      "enable_2fa": "Enable Two-Factor Authentication",
      "enabled_desc": "Your account is protected with two-factor authentication",
      "enabled_title": "2FA Enabled",
      "enter_code_desc": "Enter the 6-digit code from your authenticator app",
      "enter_code_hint": "Enter the 6-digit code",
      "enter_code_title": "Enter Verification Code",
      "extra_security": "Extra Security",
      "extra_security_desc": "Add an extra layer of protection to your account",
      "generating_key": "Generating security key...",
      "generating_key_desc": "Please wait while we generate your unique security key",
      "remove_message": "Are you sure you want to remove two-factor authentication?",
      "remove_title": "Remove 2FA",
      "scan_qr_desc": "Scan this QR code with your authenticator app",
      "scan_qr_title": "Scan QR Code",
      "scanned_code": "I''ve scanned the code",
      "secret_key": "Secret Key",
      "setup_authenticator": "Set Up Authenticator",
      "setup_authenticator_desc": "Use an authenticator app for enhanced security",
      "setup_title": "Set Up Two-Factor Authentication",
      "status": {
        "disabled": "Disabled",
        "enabled": "Enabled",
        "incomplete": "Incomplete",
        "not_enabled": "Not Enabled"
      },
      "step_scan": "Scan",
      "step_setup": "Set Up",
      "step_verify": "Verify",
      "time_based": "Time-Based",
      "time_based_desc": "Codes refresh every 30 seconds",
      "totp": "TOTP",
      "use_different_account": "Use a different account",
      "verified": "Verified",
      "verify": "Verify",
      "verifying": "Verifying..."
    },
    "name": "Name",
    "new_password": "New Password",
    "not_set": "Not Set",
    "notifications": {
      "alert_types": "Alert Types",
      "arrangements": "Arrangements",
      "community": "Community",
      "daily_digest": "Daily Digest",
      "email": "Email Notifications",
      "enable_in_settings": "Enable in device settings",
      "enable_push": "Enable Push Notifications",
      "footer": "You can change these settings at any time",
      "messages": "Messages",
      "new_listings": "New Listings",
      "open_settings": "Open Settings",
      "push": "Push Notifications",
      "push_desc": "Receive real-time updates",
      "sound": "Sound",
      "sound_vibration": "Sound & Vibration",
      "tips_updates": "Tips & Updates",
      "vibration": "Vibration",
      "weekly_newsletter": "Weekly Newsletter"
    },
    "password": "Password",
    "password_changed_success": "Password changed successfully",
    "password_min_chars": "Password must be at least 8 characters",
    "passwords_dont_match": "Passwords don''t match",
    "personal_info": "Personal Info",
    "privacy": {
      "app_privacy": "App Privacy",
      "auto_clear_clipboard": "Auto-Clear Clipboard",
      "auto_clear_desc": "Automatically clear copied sensitive data after 60 seconds",
      "clear_clipboard_now": "Clear Clipboard Now",
      "clipboard": "Clipboard Security",
      "clipboard_footer": "Protects sensitive data copied to clipboard",
      "recording_active": "Recording Active",
      "recording_alert": "Recording Alert",
      "recording_alert_desc": "Show warning when screen recording is detected",
      "recording_footer": "Alerts you if someone is recording your screen",
      "screen": "Screen Privacy",
      "screen_desc": "Hide sensitive content when app is in background",
      "screen_footer": "Protects your data in app switcher",
      "screen_recording": "Screen Recording Detection",
      "session_footer": "Automatically logs out after inactivity",
      "session_timeout": "Session Timeout"
    },
    "privacy_policy": "Privacy Policy",
    "push_notifications": "Push Notifications",
    "remove_photo": "Remove Photo",
    "section": {
      "about": "About",
      "preferences": "Preferences",
      "support": "Support"
    },
    "security": {
      "features": "Security Features",
      "out_of_100": "out of 100",
      "recommendation": "Recommendation",
      "score": "Security Score",
      "secure_account": "Secure your account",
      "setup_now": "Set up now"
    },
    "session": "Session",
    "sign_out": "Sign Out",
    "sign_out_confirm": "Are you sure you want to sign out?",
    "tap_to_change_photo": "Tap to change photo",
    "terms_of_service": "Terms of Service",
    "theme": "Theme",
    "title": "Settings",
    "two_factor": "Two-Factor Authentication",
    "verified": "Verified",
    "version": "Version"
  }'::jsonb;

  preview_keys jsonb := '{
    "cancel": "Cancel",
    "clear": "Clear",
    "retry": "Retry",
    "show_viewer": "Show Viewer",
    "show_sheet": "Show Sheet",
    "toggle_loading": "Toggle Loading",
    "show_menu": "Show Menu",
    "level_up": "Level Up",
    "badge_unlock": "Badge Unlock",
    "streak": "Streak",
    "impact": "Impact",
    "idle": "Idle",
    "load": "Load",
    "data": "Data",
    "empty": "Empty",
    "error": "Error",
    "accessibility_state": "Accessibility State",
    "voiceover_demo": "VoiceOver Demo",
    "explore": "Explore",
    "challenges": "Challenges",
    "chats": "Chats",
    "profile": "Profile",
    "brand": "Brand",
    "eco": "Eco",
    "ocean": "Ocean",
    "sunset": "Sunset",
    "midnight": "Midnight",
    "faq_title": "Frequently Asked Questions",
    "safety_guidelines": "Safety Guidelines",
    "meet_public": "Always meet in public places",
    "check_freshness": "Check food for freshness",
    "trust_instincts": "Trust your instincts"
  }'::jsonb;
BEGIN
  -- Update English translations
  UPDATE translations
  SET
    messages = deep_merge_jsonb(
      deep_merge_jsonb(
        messages,
        jsonb_build_object('admin', admin_keys)
      ),
      jsonb_build_object('settings', settings_keys, 'preview', preview_keys)
    ),
    version = to_char(now(), 'YYYYMMDDHH24MISS'),
    updated_at = now()
  WHERE locale = 'en';

  RAISE NOTICE 'Updated English translations with admin, settings, and preview keys';
END $$;

-- German translations
DO $$
DECLARE
  admin_keys_de jsonb := '{
    "access_denied": "Zugriff verweigert",
    "access_denied_message": "Sie haben keine Berechtigung, auf diesen Bereich zuzugreifen.",
    "dashboard": "Dashboard",
    "users": "Benutzer",
    "moderation": "Moderation",
    "audit_log": "Aktivitatsprotokoll",
    "title": "Admin",
    "stats": {
      "active_posts": "Aktive Beitrage",
      "active_users": "Aktive Benutzer",
      "messages": "Nachrichten",
      "pending_reports": "Ausstehende Meldungen",
      "total_posts": "Gesamte Beitrage",
      "total_users": "Gesamte Benutzer"
    },
    "moderation_status": {
      "pending": "Ausstehend",
      "in_review": "In Prufung",
      "resolved": "Gelost",
      "dismissed": "Abgewiesen",
      "escalated": "Eskaliert"
    }
  }'::jsonb;

  settings_keys_de jsonb := '{
    "title": "Einstellungen",
    "account": "Konto",
    "privacy_policy": "Datenschutzrichtlinie",
    "terms_of_service": "Nutzungsbedingungen",
    "sign_out": "Abmelden",
    "mfa": {
      "totp": "TOTP",
      "enable_2fa": "Zwei-Faktor-Authentifizierung aktivieren",
      "setup_title": "Zwei-Faktor-Authentifizierung einrichten"
    }
  }'::jsonb;
BEGIN
  UPDATE translations
  SET
    messages = deep_merge_jsonb(
      messages,
      jsonb_build_object('admin', admin_keys_de, 'settings', settings_keys_de)
    ),
    version = to_char(now(), 'YYYYMMDDHH24MISS'),
    updated_at = now()
  WHERE locale = 'de';
END $$;

-- Spanish translations
DO $$
DECLARE
  admin_keys_es jsonb := '{
    "access_denied": "Acceso denegado",
    "access_denied_message": "No tiene permiso para acceder a esta area.",
    "dashboard": "Panel de control",
    "users": "Usuarios",
    "moderation": "Moderacion",
    "audit_log": "Registro de auditoria",
    "title": "Admin",
    "stats": {
      "active_posts": "Publicaciones activas",
      "active_users": "Usuarios activos",
      "messages": "Mensajes",
      "pending_reports": "Reportes pendientes",
      "total_posts": "Total de publicaciones",
      "total_users": "Total de usuarios"
    }
  }'::jsonb;

  settings_keys_es jsonb := '{
    "title": "Configuracion",
    "account": "Cuenta",
    "privacy_policy": "Politica de privacidad",
    "terms_of_service": "Terminos de servicio",
    "sign_out": "Cerrar sesion",
    "mfa": {
      "totp": "TOTP",
      "enable_2fa": "Habilitar autenticacion de dos factores"
    }
  }'::jsonb;
BEGIN
  UPDATE translations
  SET
    messages = deep_merge_jsonb(
      messages,
      jsonb_build_object('admin', admin_keys_es, 'settings', settings_keys_es)
    ),
    version = to_char(now(), 'YYYYMMDDHH24MISS'),
    updated_at = now()
  WHERE locale = 'es';
END $$;

-- French translations
DO $$
DECLARE
  admin_keys_fr jsonb := '{
    "access_denied": "Acces refuse",
    "access_denied_message": "Vous n''avez pas la permission d''acceder a cette zone.",
    "dashboard": "Tableau de bord",
    "users": "Utilisateurs",
    "moderation": "Moderation",
    "audit_log": "Journal d''audit",
    "title": "Admin",
    "stats": {
      "active_posts": "Publications actives",
      "active_users": "Utilisateurs actifs",
      "messages": "Messages",
      "pending_reports": "Signalements en attente",
      "total_posts": "Total des publications",
      "total_users": "Total des utilisateurs"
    }
  }'::jsonb;

  settings_keys_fr jsonb := '{
    "title": "Parametres",
    "account": "Compte",
    "privacy_policy": "Politique de confidentialite",
    "terms_of_service": "Conditions d''utilisation",
    "sign_out": "Deconnexion",
    "mfa": {
      "totp": "TOTP",
      "enable_2fa": "Activer l''authentification a deux facteurs"
    }
  }'::jsonb;
BEGIN
  UPDATE translations
  SET
    messages = deep_merge_jsonb(
      messages,
      jsonb_build_object('admin', admin_keys_fr, 'settings', settings_keys_fr)
    ),
    version = to_char(now(), 'YYYYMMDDHH24MISS'),
    updated_at = now()
  WHERE locale = 'fr';
END $$;

-- For remaining locales, copy English keys with fallback
DO $$
DECLARE
  locale_row RECORD;
  en_admin jsonb;
  en_settings jsonb;
  en_preview jsonb;
BEGIN
  -- Get English translations
  SELECT
    messages->'admin',
    messages->'settings',
    messages->'preview'
  INTO en_admin, en_settings, en_preview
  FROM translations WHERE locale = 'en';

  -- Update remaining locales with English fallback where keys are missing
  FOR locale_row IN
    SELECT locale FROM translations
    WHERE locale NOT IN ('en', 'de', 'es', 'fr')
  LOOP
    UPDATE translations
    SET
      messages = deep_merge_jsonb(
        messages,
        jsonb_build_object(
          'admin', COALESCE(messages->'admin', '{}'::jsonb) || en_admin,
          'settings', COALESCE(messages->'settings', '{}'::jsonb) || en_settings,
          'preview', COALESCE(messages->'preview', '{}'::jsonb) || en_preview
        )
      ),
      version = to_char(now(), 'YYYYMMDDHH24MISS'),
      updated_at = now()
    WHERE locale = locale_row.locale;

    RAISE NOTICE 'Updated % with English fallback keys', locale_row.locale;
  END LOOP;
END $$;

-- Verify the migration
DO $$
DECLARE
  key_count int;
BEGIN
  SELECT jsonb_array_length(jsonb_path_query_array(messages, '$.admin.**'))
  INTO key_count
  FROM translations WHERE locale = 'en';

  RAISE NOTICE 'English admin keys after migration: %', key_count;
END $$;

COMMENT ON FUNCTION deep_merge_jsonb(jsonb, jsonb) IS
'Deep merges two JSONB objects recursively. Used for translation key updates.';
