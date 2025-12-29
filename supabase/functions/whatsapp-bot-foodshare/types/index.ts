/**
 * Type definitions for WhatsApp Bot
 */

// ============================================================================
// WhatsApp Webhook Types
// ============================================================================

export interface WhatsAppWebhookPayload {
  object: string;
  entry: WhatsAppEntry[];
}

export interface WhatsAppEntry {
  id: string;
  changes: WhatsAppChange[];
}

export interface WhatsAppChange {
  value: WhatsAppValue;
  field: string;
}

export interface WhatsAppValue {
  messaging_product: string;
  metadata: {
    display_phone_number: string;
    phone_number_id: string;
  };
  contacts?: WhatsAppContact[];
  messages?: WhatsAppMessage[];
  statuses?: WhatsAppStatus[];
  errors?: WhatsAppError[];
}

export interface WhatsAppContact {
  profile: {
    name: string;
  };
  wa_id: string;
}

export interface WhatsAppMessage {
  from: string;
  id: string;
  timestamp: string;
  type: "text" | "image" | "location" | "interactive" | "button" | "document" | "audio" | "video";
  text?: { body: string };
  image?: WhatsAppMedia;
  document?: WhatsAppMedia;
  audio?: WhatsAppMedia;
  video?: WhatsAppMedia;
  location?: {
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
  };
  interactive?: {
    type: "button_reply" | "list_reply";
    button_reply?: { id: string; title: string };
    list_reply?: { id: string; title: string; description?: string };
  };
  button?: {
    text: string;
    payload: string;
  };
  context?: {
    from: string;
    id: string;
  };
}

export interface WhatsAppMedia {
  id: string;
  mime_type: string;
  sha256?: string;
  caption?: string;
}

export interface WhatsAppStatus {
  id: string;
  status: "sent" | "delivered" | "read" | "failed";
  timestamp: string;
  recipient_id: string;
  errors?: WhatsAppError[];
}

export interface WhatsAppError {
  code: number;
  title: string;
  message?: string;
  error_data?: {
    details: string;
  };
}

// ============================================================================
// Interactive Message Types
// ============================================================================

export interface InteractiveButton {
  type: "reply";
  reply: {
    id: string;
    title: string; // Max 20 characters
  };
}

export interface InteractiveListSection {
  title?: string; // Max 24 characters
  rows: Array<{
    id: string; // Max 200 characters
    title: string; // Max 24 characters
    description?: string; // Max 72 characters
  }>;
}

export interface InteractiveMessage {
  messaging_product: "whatsapp";
  recipient_type: "individual";
  to: string;
  type: "interactive";
  interactive: {
    type: "button" | "list";
    header?: {
      type: "text" | "image" | "document" | "video";
      text?: string;
      image?: { link: string };
      document?: { link: string; filename: string };
      video?: { link: string };
    };
    body: { text: string };
    footer?: { text: string }; // Max 60 characters
    action: ButtonAction | ListAction;
  };
}

export interface ButtonAction {
  buttons: InteractiveButton[]; // Max 3 buttons
}

export interface ListAction {
  button: string; // Max 20 characters
  sections: InteractiveListSection[]; // Max 10 sections
}

// ============================================================================
// Outgoing Message Types
// ============================================================================

export interface TextMessage {
  messaging_product: "whatsapp";
  recipient_type: "individual";
  to: string;
  type: "text";
  text: {
    preview_url?: boolean;
    body: string;
  };
}

export interface ImageMessage {
  messaging_product: "whatsapp";
  recipient_type: "individual";
  to: string;
  type: "image";
  image: {
    link?: string;
    id?: string;
    caption?: string;
  };
}

export interface LocationMessage {
  messaging_product: "whatsapp";
  recipient_type: "individual";
  to: string;
  type: "location";
  location: {
    latitude: number;
    longitude: number;
    name?: string;
    address?: string;
  };
}

export interface TemplateMessage {
  messaging_product: "whatsapp";
  recipient_type: "individual";
  to: string;
  type: "template";
  template: {
    name: string;
    language: { code: string };
    components?: TemplateComponent[];
  };
}

export interface TemplateComponent {
  type: "header" | "body" | "button";
  parameters?: Array<{
    type: "text" | "image" | "document" | "video";
    text?: string;
    image?: { link: string };
  }>;
  sub_type?: "quick_reply" | "url";
  index?: number;
}

// ============================================================================
// Shared Types (compatible with Telegram bot)
// ============================================================================

export interface Coordinates {
  latitude: number;
  longitude: number;
}

export interface Profile {
  id: string;
  telegram_id: number | null;
  whatsapp_phone: string | null;
  email: string | null;
  email_verified: boolean;
  first_name: string | null;
  nickname: string | null;
  location: string | null;
  verification_code: string | null;
  verification_code_expires_at: string | null;
  search_radius_km?: number;
  created_time?: string;
  language?: string;
}

export interface UserStateData {
  email?: string;
  profile_id?: string;
  existing_profile_id?: string;
  next_action?: string;
  photo?: string;
  description?: string;
  caption?: string;
  language?: string;
  [key: string]: string | undefined;
}

export interface UserState {
  action: string;
  data: UserStateData;
  step?: string;
  language?: string;
}

export interface ImpactStats {
  foodsShared: number;
  foodsClaimed: number;
  kgSaved: number;
  co2Saved: number;
  moneySaved: number;
  memberSince: string;
  activeDays: number;
}
