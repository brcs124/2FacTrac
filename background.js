// background.js

// --- Global Variable ---
let latestVerificationCode = null;

// Function to get the OAuth 2.0 token
function getAuthToken(interactive) {
  return new Promise((resolve, reject) => {
    chrome.identity.getAuthToken({ interactive: interactive }, (token) => {
      if (chrome.runtime.lastError) {
        console.error("Auth Error:", chrome.runtime.lastError);
        reject(chrome.runtime.lastError);
      } else {
        console.log("Auth token obtained successfully.");
        resolve(token);
      }
    });
  });
}

// Function to fetch recent emails from Gmail
async function fetchRecentEmails(token) {
  // Search for emails in the inbox, received in the last 5 minutes
  // You might want to refine the query, e.g., add 'is:unread' or keywords
  const query = "in:inbox newer_than:5m";
  const url = `https://www.googleapis.com/gmail/v1/users/me/messages?q=${encodeURIComponent(query)}&maxResults=5`; // Limit to 5 recent messages for efficiency

  try {
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
       if (response.status === 401 || response.status === 403) {
         console.warn("Auth token might be invalid or expired. Removing cached token.");
         // Remove the potentially invalid token and try again interactively
         await removeCachedAuthToken(token);
         throw new Error(`Authorization failed (${response.status}). Please try the operation again.`);
       }
       throw new Error(`HTTP error! Status: ${response.status}`);
    }

    const data = await response.json();
    console.log("Found messages:", data);
    return data.messages || []; // Return found messages or an empty array
  } catch (error) {
    console.error('Error fetching emails:', error);
    // If fetching failed due to auth, don't re-throw if we already prompted interactively once
    if (error.message.includes("Authorization failed") && !chrome.identity.getAuthToken.interactive) {
       // Avoid infinite loops if interactive prompt also fails
    } else {
        throw error; // Re-throw other errors
    }
    return [];
  }
}

// Function to get the content of a specific email
async function getEmailContent(token, messageId) {
  const url = `https://www.googleapis.com/gmail/v1/users/me/messages/${messageId}?format=full`; // Fetch full format to get body

  try {
    const response = await fetch(url, {
      headers: {
        'Authorization': `Bearer ${token}`,
        'Content-Type': 'application/json'
      }
    });

    if (!response.ok) {
       if (response.status === 401 || response.status === 403) {
         console.warn("Auth token might be invalid or expired during content fetch.");
         await removeCachedAuthToken(token); // Remove potentially invalid token
          // No automatic retry here to avoid complexity, user might need to trigger again
       }
      throw new Error(`HTTP error fetching email content! Status: ${response.status}`);
    }

    const emailData = await response.json();
    return emailData;
  } catch (error) {
    console.error('Error fetching email content:', error);
    throw error;
  }
}

// Function to parse email body for a 6-digit code
function findSixDigitCode(emailData) {
  let bodyData = '';
  const payload = emailData.payload;

  // Find the email body, preferring plain text
  if (payload.parts) {
    // Multipart email, search for text/plain or text/html part
    const part = payload.parts.find(p => p.mimeType === 'text/plain') || payload.parts.find(p => p.mimeType === 'text/html');
    if (part && part.body && part.body.data) {
      bodyData = atob(part.body.data.replace(/-/g, '+').replace(/_/g, '/')); // Base64 decode
    }
  } else if (payload.body && payload.body.data) {
    // Single part email
     bodyData = atob(payload.body.data.replace(/-/g, '+').replace(/_/g, '/')); // Base64 decode
  }

  if (!bodyData) {
      // If plain text not found, check the snippet as a last resort (less reliable)
      bodyData = emailData.snippet || '';
  }


  // Regex to find a 6-digit code (might need refinement)
  // Looks for 6 digits potentially surrounded by spaces, start/end of line, or common separators
  // Avoids matching longer numbers by using lookarounds or word boundaries (\b)
   //const codeRegex = /(?<!\d)\b(\d{6})\b(?!\d)/; // Looks for exactly 6 digits as a 'word'
   const codeRegex = /(?:^|\s|code is:|is: |code:|:)(\d{6})(?:$|\s|\.|,)/i; // More context-aware
   const match = bodyData.match(codeRegex);

  if (match && match[1]) {
    console.log(`Found code: ${match[1]} in message ID: ${emailData.id}`);
    return match[1]; // Return the first captured group (the 6 digits)
  }

  // console.log(`No 6-digit code found in message ID: ${emailData.id}. Body analyzed:\n`, bodyData.substring(0, 500)); // Log part of the body for debugging
  return null; // No code found
}

// Function to remove a cached token if it's invalid
function removeCachedAuthToken(token) {
    return new Promise((resolve) => {
        chrome.identity.removeCachedAuthToken({ token: token }, resolve);
    });
}

// --- Offscreen Document Logic (If needed later, currently removed) ---
// async function hasOffscreenDocument(path) { ... }
// async function copyCodeToClipboard(code) { ... }

// Main function to orchestrate the process
async function findLatestVerificationCode() {
  console.log('findLatestVerificationCode triggered'); // Added log
  let token;
  try {
    token = await getAuthToken(false);
  } catch (error) {
     console.log("Need user interaction for auth token.");
     try {
         token = await getAuthToken(true);
     } catch (authError) {
         console.error("Failed to get auth token interactively:", authError);
         return null;
     }
  }

  if (!token) {
      console.error("Could not obtain authentication token.");
      return null;
  }

  try {
    const messages = await fetchRecentEmails(token);

    if (messages.length === 0) {
      console.log("No recent emails found matching the criteria.");
      // Clear the code if no recent emails are found
      // latestVerificationCode = null; 
      // Maybe don't clear it here, keep the last known good one?
      return null;
    }

    let codeFoundInThisRun = null;
    for (const message of messages) {
      console.log(`Checking message ID: ${message.id}`);
      try {
          const emailData = await getEmailContent(token, message.id);
          const code = findSixDigitCode(emailData);
          if (code) {
            console.log(`SUCCESS: Found verification code: ${code}`);
            codeFoundInThisRun = code; // Store locally first
            break; // Stop checking once we find the newest code
          }
      } catch (contentError) {
          console.error(`Skipping message ${message.id} due to error:`, contentError);
          if (contentError.message.includes("Authorization failed")) {
              console.error("Authorization failed while fetching email content. Aborting check.");
              break;
          }
      }
    }

    if (codeFoundInThisRun) {
        console.log(`Storing latest code: ${codeFoundInThisRun}`);
        latestVerificationCode = codeFoundInThisRun;
        // Optional: Call clipboard function if using offscreen doc later
        // await copyCodeToClipboard(latestVerificationCode);
        return latestVerificationCode;
    } else {
        console.log("Checked recent emails, no new 6-digit code found in this run.");
        // Decide if we should clear latestVerificationCode here
        // latestVerificationCode = null; // Option: Clear if no code found *now*
        return null;
    }

  } catch (error) {
    console.error('Error in findLatestVerificationCode:', error);
    return null;
  }
}

// --- Execution & Listeners ---

// Example: Run the check when the extension is installed/updated or Chrome starts
chrome.runtime.onStartup.addListener(() => {
  console.log("Extension startup: Running initial check.");
  findLatestVerificationCode();
});

chrome.runtime.onInstalled.addListener((details) => {
  console.log("Extension installed/updated:", details.reason);
  console.log("Running initial check on install/update.");
  getAuthToken(true).then(token => {
      if (token) {
          console.log("Initial auth successful on install.");
          findLatestVerificationCode();
      }
  }).catch(err => console.error("Initial auth failed on install:", err));

});

// REMOVE the old action listener for icon click
/*
chrome.action.onClicked.addListener((tab) => {
  console.log("Extension icon clicked. Running check.");
  findLatestVerificationCode();
});
*/

// ADD listener for messages from Popup
chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
    console.log("Background received message:", message); // Added log
    if (message.type === 'getLatestCode') {
        console.log("Responding to getLatestCode with:", latestVerificationCode); // Added log
        sendResponse({ code: latestVerificationCode });
        // Note: Keep the listener asynchronous by returning true if you might
        // call sendResponse asynchronously later (not needed here, but good practice)
        // return true;
    }
    // Handle other message types if needed
});


// Optional: Set up a periodic check (e.g., every minute)
// ... existing alarm code ...

console.log("Background script loaded.");
// Initial check attempt on load
findLatestVerificationCode();
