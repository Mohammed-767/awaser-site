importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-app-compat.js");
importScripts("https://www.gstatic.com/firebasejs/10.12.2/firebase-messaging-compat.js");
firebase.initializeApp({
  apiKey: "AIzaSyDYhnh4BrFootZFkkPg2uOkdCDWqvfyXIw",
  authDomain: "awaser-489e6.firebaseapp.com",
  projectId: "awaser-489e6",
  storageBucket: "awaser-489e6.firebasestorage.app",
  messagingSenderId: "230271282165",
  appId: "1:230271282165:web:3ed4a621c5b0ed99090ebc"
});
// يعرض Firebase إشعارات الخلفية تلقائيًا من حمولة الإشعار.
firebase.messaging();
