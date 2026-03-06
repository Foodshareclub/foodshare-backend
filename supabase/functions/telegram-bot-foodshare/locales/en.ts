/**
 * English Translations
 */

export const en = {
  // Welcome & Start
  welcome: {
    title: "🍽️ <b>Welcome to FoodShare Bot!</b>",
    welcomeBack: "Welcome Back!",
    subtitle: "🌍 <i>Together we reduce food waste and build community</i>",
    whatCanDo: "<b>🎯 What I Can Do:</b>",
    shareFood: "🍎 <b>Share Food</b> - Post surplus food with our easy form",
    findFood: "🔍 <b>Find Food</b> - Discover available food nearby",
    trackImpact: "📊 <b>Track Impact</b> - See your environmental contribution",
    joinCommunity: "🏆 <b>Join Community</b> - Connect with local food sharers",
    quickCommands: "<b>📱 Quick Commands:</b>\n/share • /find • /impact • /help",
    accountReady: "Your account is verified and ready!",
    quickActions: "Quick Actions",
    shareAction: "Share",
    shareDesc: "Post surplus food",
    findAction: "Find",
    findDesc: "Search for food",
    nearbyAction: "Nearby",
    nearbyDesc: "Browse local food",
    impactAction: "Impact",
    impactDesc: "View your stats",
    helpHint: "Use the buttons below or type /help for all commands",
  },

  // Authentication
  auth: {
    invalidEmailTitle: "Invalid Email Format",
    invalidEmailMessage: "Please send a valid email address.",
    emailAlreadyLinkedTitle: "Email Already Linked",
    emailAlreadyLinkedMessage:
      "This email is already linked to another Telegram account.\n\nIf this is your account, please contact support.",
    accountReady: "Account Ready",
    alreadyVerified: "Your account is already verified and ready to use!",
    signInTitle: "Sign In with Email",
    accountFound: "Account Found!",
    signInMessage: "Great! We found your FoodShare account.",
    checkInbox: "Check your inbox!",
    codeEmailSent: "We've sent a 6-digit verification code to your email.",
    enterCodeToSignIn: "Enter the code below to sign in and connect your Telegram account.",
    afterSignIn: "After signing in, you'll be able to",
    accessPosts: "Access all your food posts",
    manageMessages: "Manage messages via Telegram",
    trackImpact: "Track your impact on the go",
    codeExpires: "Code expires in 15 minutes",
    resendHint: "Type /resend if you didn't receive it",
    emailDeliveryFailedTitle: "Email Delivery Failed",
    emailDeliveryFailedMessage:
      "We couldn't send the verification email.\n\nPlease try again in a moment or contact support.",
    completeRegistrationTitle: "Complete Your Registration",
    completeRegistrationMessage: "We found your FoodShare account that needs verification.",
    codeEmailSentComplete: "We've sent a 6-digit verification code to complete your registration.",
    enterCodeToVerify: "Enter the code below to verify and link your Telegram account.",
    afterVerification: "After verification, you'll be able to",
    shareFood: "Share surplus food",
    findFood: "Find food nearby",
    registrationFailedTitle: "Registration Failed",
    registrationFailedMessage:
      "We couldn't create your account.\n\nPlease try again or contact support.",
    verifyEmailTitle: "Verify Your Email",
    accountCreated: "Account Created!",
    codeSentTo: "A 6-digit code has been sent to:",
    joinRevolution: "Join the food-sharing revolution!",
    reduceWaste: "Reduce food waste",
    getStarted: "Get Started",
    newUser: "New User?",
    sendEmailToRegister: "Send your email to register",
    haveAccount: "Have an account?",
    sendEmailToSignIn: "Send your registered email to sign in",
    selectLanguage: "Select your language",
  },

  // Language
  language: {
    changed: "Language Changed",
    selectedLanguage: "Selected language",
    continueMessage: "Let's continue with your registration!",
    selectTitle: "Select Language",
    selectMessage: "Choose your preferred language for the bot:",
  },

  // Share Food
  share: {
    title: "🍎 <b>Share Food with FoodShare</b>",
    chooseMethod: "Choose how you'd like to post your food:",
    webFormRecommended: "🌟 <b>Recommended:</b> Use our beautiful web form",
    chatAlternative: "💬 <b>Alternative:</b> Share via chat messages",
    webFormFaster: "<i>The web form is faster and easier!</i>",
    openFormButton: "🍎 Open Form",
    useChatButton: "📱 Use Chat Instead",

    // Chat flow
    step1Photo:
      "📸 <b>Step 1 of 3: Photo</b>\n\nSend me a photo of the food you want to share.\n\n💡 <i>Tip: Good photos get more interest!</i>\n\nType /cancel to stop",
    step2Description:
      "✅ <b>Photo Received!</b>\n\n📝 <b>Step 2 of 3: Description</b>\n\nTell people about your food:\n• What is it?\n• How much?\n• Any special notes?\n\n━━━━━━━━━━━━━━━━━━━━\n\n<b>Example:</b>\n<i>Fresh Apples from My Garden\n\nAbout 2kg of organic apples.\nPerfect for eating or baking.\nAvailable for pickup today until 6pm.</i>\n\n━━━━━━━━━━━━━━━━━━━━\n\nType your description:",
    step3Location:
      '✅ <b>Description Saved!</b>\n\n📍 <b>Step 3 of 3: Location</b>\n\nWhere can people pick this up?\n\n━━━━━━━━━━━━━━━━━━━━\n\n<b>Options:</b>\n\n📝 <b>Type address:</b>\n<i>"Prague 1, Wenceslas Square"</i>\n\n📱 <b>Share GPS:</b>\n<i>Use Telegram\'s location button</i>\n\n⏭️ <b>Skip:</b>\n<i>Type "skip" to use your profile location</i>\n\n━━━━━━━━━━━━━━━━━━━━\n\nType your location:',
    lookingUpLocation: "📍 Looking up location...",
    locationNotFound:
      '❌ Couldn\'t find that location. Please try:\n• A more specific address\n• City name (e.g., "Prague")\n• Type "skip" to use your profile location\n• Or /cancel to stop',
    success:
      '🎉 <b>Food Shared Successfully!</b>\n\nYour food is now available for the community.\n\n🔗 <a href="{url}">View Your Post</a>{locationNote}\n\nThank you for reducing food waste! 🌍',
    noLocationNote:
      "\n\n⚠️ <i>Note: No location set. Add location on mobile or website for better visibility.</i>",
    linkAccountFirst:
      '❌ Please link your Telegram account on FoodShare first:\n🔗 <a href="{url}">Link Account</a>',
  },

  // Find Food
  find: {
    title: "🔍 <b>Found {count} food items:</b>",
    noFood: "No food available right now. Be the first to share! Use /share",
    noMatch: 'No food found matching "{query}". Try a different search!',
  },

  // Profile & Impact
  profile: {
    title: "👤 <b>Your Profile</b>",
    manageOnWebsite: 'Manage your profile on the website:\n🔗 <a href="{url}">Open Profile</a>',
  },

  impact: {
    title: "🌍 <b>Your Environmental Impact</b>",
    foodShared: "🍎 Food Shared: {count} items",
    foodClaimed: "🎯 Food Claimed: {count} items",
    wastePrevented: "♻️ Waste Prevented: {kg}kg",
    co2Saved: "🌱 CO2 Saved: {kg}kg",
    moneySaved: "💰 Value Saved: ${amount}",
    memberSince: "📅 Member Since: {date}",
    badges: "🏅 <b>Badges:</b> {badges}",
  },

  // Stats & Leaderboard
  stats: {
    title: "📊 <b>Your Statistics</b>",
    messages: "💬 Messages: {count}",
    commands: "⚡ Commands: {count}",
    lastActive: "🕐 Last Active: {date}",
    noStatsYet: "📊 No statistics found yet. Start sharing food to build your stats!",
    linkAccountFirst:
      '❌ Please link your Telegram account on FoodShare first:\n🔗 <a href="{url}">Link Account</a>',
  },

  leaderboard: {
    title: "🏆 <b>Top Contributors</b>",
    noData: "🏆 No leaderboard data available yet. Be the first to share food!",
  },

  // Help
  help: {
    title: "🍽️ <b>FoodShare Bot - All Commands</b>",
    foodSharing: "<b>🍎 Food Sharing:</b>",
    shareCmd: "/share - Share surplus food",
    findCmd: "/find [item] - Search for food",
    nearbyCmd: "/nearby - Food near your location",
    profileSection: "<b>👤 Profile:</b>",
    profileCmd: "/profile - View/edit your profile",
    impactCmd: "/impact - Your environmental impact",
    communitySection: "<b>📊 Community:</b>",
    statsCmd: "/stats - Your activity statistics",
    leaderboardCmd: "/leaderboard - Top contributors",
    otherSection: "<b>ℹ️ Other:</b>",
    languageCmd: "/language - Change language",
    helpCmd: "/help - Show this message",
    cancelCmd: "/cancel - Cancel current action",
    tip: "<i>Tip: Use the buttons below for quick actions!</i>",
  },

  // Common
  common: {
    example: "Example",
    email: "Email",
    back: "« Back",
    cancel: "❌ Action cancelled.",
    error: "❌ Error: {message}",
    comingSoon:
      "📍 <b>Nearby Food</b>\n\nThis feature is coming soon! Use /find to see all available food for now.",
  },

  // Buttons
  buttons: {
    shareFood: "Share Food",
    findFood: "Find Food",
    nearbyFood: "Nearby Food",
    myProfile: "My Profile",
    myStats: "My Impact",
    leaderboard: "Leaderboard",
    openFoodShare: "Open FoodShare",
  },

  // Menu (persistent keyboard)
  menu: {
    shareFood: "🍎 Share",
    findFood: "🔍 Find",
    nearby: "📍 Nearby",
    profile: "👤 Profile",
    impact: "🌍 Impact",
    stats: "📊 Stats",
    help: "❓ Help",
    language: "🌐 Language",
    leaderboard: "🏆 Leaders",
  },
};
