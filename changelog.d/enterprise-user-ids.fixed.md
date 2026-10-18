- Recipient routing, the explicit access policy, the recipient-aware host
  contract and `SLACK_RECIPIENT_ROUTING`'s `expectedBotUserId` accepted only
  `U…` user IDs. A message whose author or mention carried an Enterprise Grid
  `W…` ID threw after the Socket Mode event was acknowledged, so the message
  was lost. Both forms now pass everywhere a user ID is checked, as
  `fetch_history`'s `authorIds` already did.
