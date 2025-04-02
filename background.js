// background.js

// --- Global Variables ---
let latestVerificationCode = null;
let latestSender = null;
let latestVerificationLink = null;
let currentTabDomain = null;

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

// Function to get sender name from email
function getSenderName(emailData) {
  if (!emailData || !emailData.payload || !emailData.payload.headers) {
    return null;
  }

  // Look for the 'From' header
  const fromHeader = emailData.payload.headers.find(header => 
    header.name.toLowerCase() === 'from'
  );

  if (!fromHeader || !fromHeader.value) {
    return null;
  }

  // Extract the name from the "Name <email@example.com>" format
  const fromValue = fromHeader.value;
  const nameMatch = fromValue.match(/^([^<]+)<.*>$/);
  
  if (nameMatch && nameMatch[1]) {
    // Return the name part, trimmed of whitespace
    return nameMatch[1].trim();
  } else {
    // If no match (e.g., just an email address), return the whole value
    return fromValue;
  }
}

// Function to parse email body for verification codes
function findVerificationCode(emailData) {
  let bodyData = '';
  let htmlBody = '';
  const payload = emailData.payload;

  // Find the email body, getting both plain text for regex and HTML for element parsing
  if (payload.parts) {
    // Get both plain text and HTML content
    const plainTextPart = payload.parts.find(p => p.mimeType === 'text/plain');
    const htmlPart = payload.parts.find(p => p.mimeType === 'text/html');
    
    // Extract plain text content if available
    if (plainTextPart && plainTextPart.body && plainTextPart.body.data) {
      bodyData = atob(plainTextPart.body.data.replace(/-/g, '+').replace(/_/g, '/'));
    }
    
    // Extract HTML content if available
    if (htmlPart && htmlPart.body && htmlPart.body.data) {
      htmlBody = atob(htmlPart.body.data.replace(/-/g, '+').replace(/_/g, '/'));
      
      // If no plain text, use HTML with tags removed as fallback for regex searches
      if (!bodyData) {
        bodyData = htmlBody.replace(/<[^>]*>/g, ' ');
      }
    }
  } else if (payload.body && payload.body.data) {
    const data = atob(payload.body.data.replace(/-/g, '+').replace(/_/g, '/'));
    
    if (payload.mimeType === 'text/html') {
      htmlBody = data;
      bodyData = data.replace(/<[^>]*>/g, ' '); // Strip tags for regex search
    } else {
      bodyData = data;
    }
  }

  if (!bodyData) {
    bodyData = emailData.snippet || '';
  }

  // --- PART 1: Standard Numeric Code Detection (6-7 digits) ---
  
  // First check: Numeric codes with verification context
  const codeRegex = /(?:code is |is: |code: |verification code |\b)(\d{6,7})\b/i; 
  const match = bodyData.match(codeRegex);

  if (match && match[1]) {
    console.log(`Found numeric code with context (${match[1].length} digits): ${match[1]} in message ID: ${emailData.id}`);
    return match[1]; // Return the captured digits
  }
  
  // Second check: Standalone numeric codes (fallback for just numbers)
  const fallbackRegex = /\b(\d{6,7})\b/;
  const fallbackMatch = bodyData.match(fallbackRegex);
  if (fallbackMatch && fallbackMatch[1]) {
    // Avoid matching things that look like years in common ranges
    const potentialCode = parseInt(fallbackMatch[1], 10);
    if (potentialCode < 1900 || potentialCode > 2100) { 
      console.log(`Found standalone numeric code (${fallbackMatch[1].length} digits): ${fallbackMatch[1]} in message ID: ${emailData.id}`);
      return fallbackMatch[1];
    }
  }

  // --- PART 2: Isolated Short Text in HTML Elements (New Approach) ---
  if (htmlBody) {
    // 1. Find content inside common HTML elements that is 4-7 characters long and appears alone
    const elementTypes = ['div', 'td', 'tr', 'h[1-6]', 'p', 'span', 'strong', 'b', 'em', 'i', 'a', 'li'];
    
    // Create a dynamic regex pattern to match isolated content in various HTML elements
    for (const element of elementTypes) {
      // This pattern matches elements with only whitespace and the potential code
      const elementRegex = new RegExp(`<${element}[^>]*>\\s*([\\w\\d\\-]{4,7})\\s*<\\/${element.replace('[1-6]', '\\d')}>`, 'gi');
      
      let elementMatch;
      while ((elementMatch = elementRegex.exec(htmlBody)) !== null) {
        const potentialCode = elementMatch[1].trim();
        console.log(`Found isolated text in ${element}: "${potentialCode}"`);
        
        // Check if this looks like a verification code - for short isolated text, we use more lenient criteria
        if (isShortIsolatedCode(potentialCode)) {
          console.log(`Found short isolated code in ${element}: ${potentialCode}`);
          return potentialCode;
        }
      }
    }
    
    // 2. Look for elements with specific styling that indicates they're meant to stand out
    // These often contain verification codes
    const styledElementRegex = /<[^>]*style=['"][^'"]*(?:font-size|font-weight|color|background|text-align\s*:\s*center)[^'"]*['"][^>]*>([\s\n]*)([A-Z0-9\-]{4,7})([\s\n]*)</gi;
    let styledMatch;
    while ((styledMatch = styledElementRegex.exec(htmlBody)) !== null) {
      const potentialCode = styledMatch[2].trim();
      if (isShortIsolatedCode(potentialCode)) {
        console.log(`Found styled short code: ${potentialCode}`);
        return potentialCode;
      }
    }
    
    // 3. Look for content that appears visually separated (often in a table or with CSS styling)
    // This is a more aggressive approach to find isolated content
    const visuallySeparatedRegex = /(?:>|^)\s*([A-Z0-9\-]{4,7})\s*(?:<|$)/gi;
    let separatedMatch;
    while ((separatedMatch = visuallySeparatedRegex.exec(htmlBody)) !== null) {
      const potentialCode = separatedMatch[1].trim();
      if (isShortIsolatedCode(potentialCode)) {
        console.log(`Found visually separated short code: ${potentialCode}`);
        return potentialCode;
      }
    }
  }

  // No verification code found
  return null;
}

// Helper function specifically for short isolated codes (4-7 chars)
function isShortIsolatedCode(str) {
  // Clean up the string
  str = str.trim();
  
  // Check basic length criteria (4-7 characters for isolated codes)
  if (str.length < 4 || str.length > 7) {
    return false;
  }
  
  // Must have either:
  // 1. At least one letter and one number for mixed alphanumeric codes
  // 2. All digits for numeric codes (length-validated above)
  const hasLetter = /[a-z]/i.test(str);
  const hasNumber = /\d/.test(str);
  const allDigits = /^\d+$/.test(str);
  
  if (allDigits && str.length >= 5) {
    // Pure digit codes should be 5-7 digits
    return true;
  }
  
  if (hasLetter && hasNumber) {
    // Mixed alphanumeric codes
    return true;
  }
  
  // Common formats for verification codes
  if (/^[A-Z0-9]{2,4}-[A-Z0-9]{1,3}$/i.test(str)) {
    // Formats like "FQP-UN3" or "A1-B2C"
    return true;
  }
  
  // Avoid common words and single words
  const lowerStr = str.toLowerCase();
  if (/^[a-z]+$/i.test(str)) {
    // Avoid single words made up of only letters
    return false;
  }
  
  const commonWords = ['click', 'here', 'login', 'go', 'open', 'view', 'visit', 'see'];
  if (commonWords.includes(lowerStr)) {
    return false;
  }
  
  // For short isolated content, if it contains a number, it's more likely a code
  return hasNumber;
}

// Function to remove a cached token if it's invalid
function removeCachedAuthToken(token) {
    return new Promise((resolve) => {
        chrome.identity.removeCachedAuthToken({ token: token }, resolve);
    });
}

// Function to extract verification links from an email that match a given domain
function findVerificationLink(emailData, targetDomain) {
  if (!targetDomain) {
    console.log("No target domain provided for link matching");
    return null;
  }

  console.log(`Looking for links related to domain: "${targetDomain}"`);
  
  let bodyData = '';
  const payload = emailData.payload;

  // Get both HTML and plain text content when available
  let htmlBody = '';
  let textBody = '';
  
  // Extract email content
  if (payload.parts) {
    // Process multipart email
    for (const part of payload.parts) {
      if (part.mimeType === 'text/html' && part.body && part.body.data) {
        htmlBody = atob(part.body.data.replace(/-/g, '+').replace(/_/g, '/'));
      } else if (part.mimeType === 'text/plain' && part.body && part.body.data) {
        textBody = atob(part.body.data.replace(/-/g, '+').replace(/_/g, '/'));
      }
      
      // Handle nested multipart messages
      if (part.parts) {
        for (const nestedPart of part.parts) {
          if (nestedPart.mimeType === 'text/html' && nestedPart.body && nestedPart.body.data) {
            htmlBody += atob(nestedPart.body.data.replace(/-/g, '+').replace(/_/g, '/'));
          } else if (nestedPart.mimeType === 'text/plain' && nestedPart.body && nestedPart.body.data) {
            textBody += atob(nestedPart.body.data.replace(/-/g, '+').replace(/_/g, '/'));
          }
        }
      }
    }
  } else if (payload.body && payload.body.data) {
    // Process single part email
    const data = atob(payload.body.data.replace(/-/g, '+').replace(/_/g, '/'));
    if (payload.mimeType === 'text/html') {
      htmlBody = data;
    } else {
      textBody = data;
    }
  }
  
  // Prefer HTML for links, fallback to text
  bodyData = htmlBody || textBody || emailData.snippet || '';
  
  console.log(`Email body length: ${bodyData.length} characters`);
  
  // Common verification link keywords
  const verificationKeywords = [
    'verify', 'verification', 'confirm', 'confirmation', 'activate', 'validation',
    'account', 'sign-in', 'login', 'sign in', 'signin', 'log in', 
    'authenticate', 'email', 'click here', 'link', 'authorize', 'approve'
  ];
  
  // Strong verification patterns in the URL path or parameters
  const strongVerificationPatterns = [
    /\/verify/, /\/verification/, /\/confirm/, /\/validate/, /\/activate/,
    /token=/, /code=/, /key=/, /confirm_email/, /email-verification/,
    /verify-email/, /account-confirm/, /sign-in/, /login/, /auth/
  ];

  // Extract all URLs from the body
  // More robust regex for URLs that handles special characters better
  const urlRegex = /https?:\/\/(?:www\.)?[-a-zA-Z0-9@:%._+~#=]{1,256}\.[a-zA-Z0-9()]{1,6}\b(?:[-a-zA-Z0-9()@:%_+.~#?&//=]*)/gi;
  let urls = bodyData.match(urlRegex) || [];
  
  // Special handling for HTML: extract href attributes which sometimes contain encoded URLs
  if (htmlBody) {
    const hrefRegex = /href=["']([^"']+)["']/gi;
    let hrefMatch;
    while ((hrefMatch = hrefRegex.exec(htmlBody)) !== null) {
      if (hrefMatch[1].startsWith('http')) {
        urls.push(hrefMatch[1]);
      }
    }
  }
  
  // Remove duplicates
  urls = [...new Set(urls)];
  
  console.log(`Found ${urls.length} unique URLs in the email`);
  
  // Group all found URLs by priority
  const domainExactMatches = [];
  const domainContainsMatches = [];
  const verificationIndicatorMatches = [];
  const otherUrls = [];
  
  for (const url of urls) {
    try {
      const urlObj = new URL(url);
      const urlBaseDomain = extractBaseDomain(url);
      
      // Classify this URL
      if (urlBaseDomain === targetDomain) {
        // Exact domain match
        console.log(`Exact domain match: ${url}`);
        domainExactMatches.push(url);
      } else if (urlObj.hostname.includes(targetDomain)) {
        // Contains domain match (like auth.example.com)
        console.log(`Contains domain: ${url}`);
        domainContainsMatches.push(url);
      } else {
        // Check for verification indicators in other domains
        let hasVerificationIndicator = false;
        
        // Check URL for verification patterns
        for (const pattern of strongVerificationPatterns) {
          if (pattern.test(url)) {
            console.log(`URL with verification pattern: ${url} (pattern: ${pattern})`);
            hasVerificationIndicator = true;
            break;
          }
        }
        
        // Check for verification keywords
        if (!hasVerificationIndicator) {
          const lowerUrl = url.toLowerCase();
          for (const keyword of verificationKeywords) {
            if (lowerUrl.includes(keyword.toLowerCase())) {
              console.log(`URL with verification keyword: ${url} (keyword: ${keyword})`);
              hasVerificationIndicator = true;
              break;
            }
          }
        }
        
        if (hasVerificationIndicator) {
          verificationIndicatorMatches.push(url);
        } else {
          otherUrls.push(url);
        }
      }
    } catch (e) {
      console.error(`Invalid URL: ${url}`, e);
      // Skip invalid URLs
    }
  }
  
  // Search for surrounding text to find verification links
  // This helps identify which links are verification links based on the text around them
  const surroundingTextMatches = [];
  
  // Process HTML by finding link text
  if (htmlBody) {
    const anchorTagRegex = /<a\s+(?:[^>]*?\s+)?href=["']([^"']*)["'][^>]*>(.*?)<\/a>/gi;
    let anchorMatch;
    while ((anchorMatch = anchorTagRegex.exec(htmlBody)) !== null) {
      const linkUrl = anchorMatch[1];
      const linkText = anchorMatch[2].replace(/<[^>]*>/g, '').trim(); // Strip any nested HTML tags
      
      // Check if the link text has verification keywords
      const lowerLinkText = linkText.toLowerCase();
      for (const keyword of verificationKeywords) {
        if (lowerLinkText.includes(keyword.toLowerCase())) {
          console.log(`Found link with verification text: "${linkText}" -> ${linkUrl}`);
          surroundingTextMatches.push(linkUrl);
          break;
        }
      }
    }
  }
  
  // Search for verification context in text content
  if (textBody) {
    // Find lines that contain both a URL and verification keywords
    const lines = textBody.split('\n');
    for (const line of lines) {
      // Skip very long lines (likely not meaningful context)
      if (line.length > 300) continue;
      
      const lowerLine = line.toLowerCase();
      let containsVerificationKeyword = false;
      
      for (const keyword of verificationKeywords) {
        if (lowerLine.includes(keyword.toLowerCase())) {
          containsVerificationKeyword = true;
          break;
        }
      }
      
      if (containsVerificationKeyword) {
        // Check if this line also contains a URL
        const urlsInLine = line.match(urlRegex);
        if (urlsInLine) {
          for (const url of urlsInLine) {
            console.log(`Found URL in verification context: ${url}`);
            surroundingTextMatches.push(url);
          }
        }
      }
    }
  }
  
  // Prioritize URLs
  
  // 1. First priority: Exact domain match + verification indicator
  const exactMatchWithVerification = domainExactMatches.filter(url => {
    // Check if URL is in surroundingTextMatches
    if (surroundingTextMatches.includes(url)) return true;
    
    // Check for verification patterns
    for (const pattern of strongVerificationPatterns) {
      if (pattern.test(url)) return true;
    }
    
    // Check for verification keywords
    const lowerUrl = url.toLowerCase();
    return verificationKeywords.some(kw => lowerUrl.includes(kw.toLowerCase()));
  });
  
  if (exactMatchWithVerification.length > 0) {
    console.log(`FOUND: Exact domain match with verification indicators: ${exactMatchWithVerification[0]}`);
    return exactMatchWithVerification[0];
  }
  
  // 2. Second priority: Contains domain + verification indicator
  const containsMatchWithVerification = domainContainsMatches.filter(url => {
    // Check if URL is in surroundingTextMatches
    if (surroundingTextMatches.includes(url)) return true;
    
    // Check for verification patterns
    for (const pattern of strongVerificationPatterns) {
      if (pattern.test(url)) return true;
    }
    
    // Check for verification keywords
    const lowerUrl = url.toLowerCase();
    return verificationKeywords.some(kw => lowerUrl.includes(kw.toLowerCase()));
  });
  
  if (containsMatchWithVerification.length > 0) {
    console.log(`FOUND: Domain-containing match with verification indicators: ${containsMatchWithVerification[0]}`);
    return containsMatchWithVerification[0];
  }
  
  // 3. Third priority: Any exact domain match
  if (domainExactMatches.length > 0) {
    console.log(`FOUND: Exact domain match without verification indicators: ${domainExactMatches[0]}`);
    return domainExactMatches[0];
  }
  
  // 4. Fourth priority: Any contains domain match
  if (domainContainsMatches.length > 0) {
    console.log(`FOUND: Domain-containing match without verification indicators: ${domainContainsMatches[0]}`);
    return domainContainsMatches[0];
  }
  
  // 5. Fifth priority: Any verification indicator match
  if (verificationIndicatorMatches.length > 0) {
    console.log(`FOUND: Non-domain match with verification indicators: ${verificationIndicatorMatches[0]}`);
    return verificationIndicatorMatches[0];
  }
  
  // 6. Sixth priority: Any link with verification context
  const remainingContextMatches = surroundingTextMatches.filter(
    url => !domainExactMatches.includes(url) && 
           !domainContainsMatches.includes(url) && 
           !verificationIndicatorMatches.includes(url)
  );
  
  if (remainingContextMatches.length > 0) {
    console.log(`FOUND: Link with verification context: ${remainingContextMatches[0]}`);
    return remainingContextMatches[0];
  }
  
  // No suitable verification links found
  console.log(`No suitable verification links found for domain "${targetDomain}"`);
  return null;
}

// Function to extract the base domain from a URL
function extractBaseDomain(url) {
  try {
    const urlObj = new URL(url);
    // Get the hostname (e.g., "www.example.com")
    let hostname = urlObj.hostname;
    
    // Extract the base domain (typically the last two parts, e.g., "example.com")
    const parts = hostname.split('.');
    if (parts.length > 2) {
      // Handle domains like "www.example.co.uk" or "sub.example.com"
      // For well-known TLDs like .co.uk, .com.au, we want to keep the last 3 parts
      const lastPart = parts[parts.length - 1];
      const secondLastPart = parts[parts.length - 2];
      
      if ((secondLastPart === 'co' || secondLastPart === 'com' || 
           secondLastPart === 'org' || secondLastPart === 'net' || 
           secondLastPart === 'gov' || secondLastPart === 'edu') && 
          lastPart.length <= 3) {
        // This looks like a country code TLD with a second level domain
        return `${parts[parts.length - 3]}.${secondLastPart}.${lastPart}`;
      } else {
        // Regular domain with subdomain(s)
        return `${secondLastPart}.${lastPart}`;
      }
    }
    
    return hostname; // Return as is if it's already a base domain
  } catch (e) {
    console.error("Error extracting base domain:", e);
    return null;
  }
}

// Function to get the current tab's URL
async function getCurrentTabURL() {
  return new Promise((resolve) => {
    chrome.tabs.query({ active: true, currentWindow: true }, (tabs) => {
      if (tabs && tabs.length > 0 && tabs[0].url) {
        const url = tabs[0].url;
        console.log(`Current tab URL: ${url}`);
        const baseDomain = extractBaseDomain(url);
        console.log(`Extracted base domain: ${baseDomain}`);
        resolve(baseDomain);
      } else {
        console.log("No active tab found or URL is undefined");
        resolve(null);
      }
    });
  });
}

// Main function to orchestrate the process
async function findLatestVerificationCode() {
  console.log('findLatestVerificationCode triggered');
  
  // First, try to get the current tab's domain
  try {
    currentTabDomain = await getCurrentTabURL();
    console.log(`Current tab domain for verification link matching: ${currentTabDomain}`);
  } catch (error) {
    console.error("Error getting current tab URL:", error);
    currentTabDomain = null;
  }
  
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
      return null;
    }

    console.log(`Processing ${messages.length} recent emails for verification information...`);
    
    // We'll store the results from each email
    const emailResults = [];
    
    // Process each email to find codes and links
    for (const message of messages) {
      console.log(`Checking message ID: ${message.id}`);
      try {
          const emailData = await getEmailContent(token, message.id);
          const senderName = getSenderName(emailData);
          
          // For each email, check for both code and link
          const result = {
            messageId: message.id,
            sender: senderName,
            code: null,
            link: null,
            linkType: null, // Track the type of link for better prioritization
            timestamp: emailData.internalDate ? parseInt(emailData.internalDate) : new Date().getTime() // Use actual email timestamp when available
          };
          
          // Always look for a verification code
          const code = findVerificationCode(emailData);
          if (code) {
            console.log(`Found verification code: ${code} in message ${message.id}`);
            result.code = code;
          }
          
          // Always look for a verification link if we have a domain
          if (currentTabDomain) {
            const link = findVerificationLink(emailData, currentTabDomain);
            if (link) {
              console.log(`Found verification link: ${link} in message ${message.id}`);
              result.link = link;
              
              // Classify the link type
              try {
                const urlBaseDomain = extractBaseDomain(link);
                if (urlBaseDomain === currentTabDomain) {
                  result.linkType = 'exact_domain';
                  console.log(`Link is exact domain match: ${link}`);
                } else if (new URL(link).hostname.includes(currentTabDomain)) {
                  result.linkType = 'contains_domain';
                  console.log(`Link contains domain: ${link}`);
                } else {
                  // Don't use links from other domains
                  result.linkType = 'other_domain';
                  console.log(`Link is from another domain (will be ignored): ${link}`);
                  result.link = null; // Clear the link since it doesn't match our domain
                }
              } catch (e) {
                result.linkType = 'other_domain';
                console.error(`Error classifying link: ${link}`, e);
                result.link = null; // Clear the link due to error
              }
            }
          }
          
          // Only add this email to results if we found either a code or link
          if (result.code || result.link) {
            // Log the timestamp for debugging
            const date = new Date(result.timestamp);
            console.log(`Storing verification info from message ${message.id} - Code: ${result.code}, Link: ${result.link}, Date: ${date.toISOString()}`);
            emailResults.push(result);
          }
          
      } catch (contentError) {
          console.error(`Skipping message ${message.id} due to error:`, contentError);
          if (contentError.message.includes("Authorization failed")) {
              console.error("Authorization failed while fetching email content. Aborting check.");
              break;
          }
      }
    }
    
    // After processing all emails, find the best result to use
    if (emailResults.length > 0) {
      console.log(`Found ${emailResults.length} emails with verification information`);
      
      // CHANGED PRIORITY:
      // 1. Most recent email with a code
      // 2. Then consider links (domain matches only)
      
      // First, get the most recent email with a code
      const emailsWithCodes = emailResults.filter(result => result.code);
      
      if (emailsWithCodes.length > 0) {
        // Sort by timestamp (most recent first)
        emailsWithCodes.sort((a, b) => b.timestamp - a.timestamp);
        
        // Use the most recent email with a code
        const bestMatch = emailsWithCodes[0];
        console.log(`Using most recent email with code from message ${bestMatch.messageId} (timestamp: ${new Date(bestMatch.timestamp).toISOString()})`);
        
        // If it doesn't have a link, find the best link from domain-matching emails
        if (!bestMatch.link) {
          console.log("Most recent email with code has no link. Looking for a good link in other emails...");
          
          // Find emails with domain-matching links
          const emailsWithLinks = emailResults.filter(result => 
            result.link && (result.linkType === 'exact_domain' || result.linkType === 'contains_domain')
          );
          
          if (emailsWithLinks.length > 0) {
            console.log(`Found ${emailsWithLinks.length} emails with domain-matching links for potential fallback`);
            
            // Sort links by priority:
            // 1. Exact domain matches first
            // 2. Contains domain matches second
            // 3. More recent within each category
            emailsWithLinks.sort((a, b) => {
              // First priority: Exact domain match
              const aExactDomain = a.linkType === 'exact_domain';
              const bExactDomain = b.linkType === 'exact_domain';
              if (aExactDomain && !bExactDomain) return -1;
              if (!aExactDomain && bExactDomain) return 1;
              
              // Second priority: More recent
              return b.timestamp - a.timestamp;
            });
            
            // Get the best link after sorting
            const bestLinkEmail = emailsWithLinks[0];
            console.log(`Found best domain-matching link from message ${bestLinkEmail.messageId}: ${bestLinkEmail.link} (type: ${bestLinkEmail.linkType})`);
            
            // Use this link with our best match
            bestMatch.link = bestLinkEmail.link;
          } else {
            console.log("No domain-matching links found in any email, will not include a link in the response");
          }
        }
        
        // Store the results in global variables
        latestVerificationCode = bestMatch.code;
        latestVerificationLink = bestMatch.link;
        latestSender = bestMatch.sender;
      } 
      else {
        // No emails with codes, just use the most recent email with a domain-matching link
        const emailsWithDomainLinks = emailResults.filter(result => 
          result.link && (result.linkType === 'exact_domain' || result.linkType === 'contains_domain')
        );
        
        if (emailsWithDomainLinks.length > 0) {
          // Sort by timestamp
          emailsWithDomainLinks.sort((a, b) => b.timestamp - a.timestamp);
          
          const bestMatch = emailsWithDomainLinks[0];
          console.log(`No codes found. Using most recent email with domain link from message ${bestMatch.messageId}`);
          
          // Store the results in global variables
          latestVerificationCode = null;
          latestVerificationLink = bestMatch.link;
          latestSender = bestMatch.sender;
        } else {
          console.log("No emails with domain-matching links either. No verification info to return.");
          latestVerificationCode = null;
          latestVerificationLink = null;
          latestSender = null;
        }
      }
      
      // Return the result
      return {
        code: latestVerificationCode,
        link: latestVerificationLink,
        sender: latestSender
      };
    } else {
      console.log("No verification information found in any recent emails.");
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
    console.log("Background received message:", message);
    
    if (message.type === 'triggerFetchAndGetCode') {
        console.log("Trigger received. Running fresh email check...");
        // Run the check and handle response asynchronously
        findLatestVerificationCode().then(result => {
            console.log("Fresh check completed, sending response:", { 
              code: latestVerificationCode, 
              link: latestVerificationLink,
              sender: latestSender 
            });
            // Respond with all latest verification info
            sendResponse({ 
              code: latestVerificationCode, 
              link: latestVerificationLink,
              sender: latestSender 
            });
        }).catch(error => {
            console.error("Error during fresh check:", error);
            sendResponse({ 
              code: latestVerificationCode, 
              link: latestVerificationLink,
              sender: latestSender 
            });
        });
        
        // Return true to indicate we'll respond asynchronously
        return true;
    }
    else if (message.type === 'getLatestCode') {
        // Keep the existing handler for backward compatibility
        console.log("Responding to getLatestCode with:",
            { code: latestVerificationCode, link: latestVerificationLink, sender: latestSender });
        sendResponse({ 
          code: latestVerificationCode, 
          link: latestVerificationLink,
          sender: latestSender 
        });
    }
    // Handle other message types if needed
});


// Optional: Set up a periodic check (e.g., every minute)
// ... existing alarm code ...

console.log("Background script loaded.");
// Initial check attempt on load
findLatestVerificationCode();
