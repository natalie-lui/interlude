const baseURL = process.env.BASE_URL;

const express = require('express');
const request = require('request');
const querystring = require('querystring');

const app = express();
//const port = 3000;
const port = process.env.PORT || 3000;

const scopes = [
    'user-top-read',
    'user-read-recently-played',
    'playlist-modify-public',
    'playlist-modify-private'
].join(' '); //spotify api permissions

const sessions = {};

app.use(express.urlencoded({ extended: true }));
app.use(express.json());

//security
function generateRandomString(len){
    let text = '';
    const possible = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';

    for(let i = 0; i < len; i++){
        text += possible.charAt(Math.floor(Math.random() * possible.length));
    }

    return text;
}

app.get('/', (req, res) => {
    res.send('<a href="/login">Log in with Spotify</a>')
});

app.get('/login', (req,res) => {
    let {session, user} = req.query;
    if(!session){
        session=generateRandomString(16);
        sessions[session] = {};
    }

    user= user || '1';

    const state = Buffer.from(JSON.stringify({ session, user })).toString('base64');
    const params = querystring.stringify({
        response_type: 'code',
        client_id: process.env.SPOTIFY_CLIENT_ID,
        scope: scopes,
        redirect_uri: process.env.SPOTIFY_REDIRECT_URI,
        state: state,
    });
    res.redirect('https://accounts.spotify.com/authorize?' + params);
});

app.get('/callback', (req, res)=>{
    const code = req.query.code || null;
    const stateParam = req.query.state || null;

    if (!code || !stateParam) {
        res.send('Missing code or state.');
        return;
    }

    let stateDecoded;
    try{
        stateDecoded = JSON.parse(Buffer.from(stateParam, 'base64').toString('utf-8'));
    } catch (e) {
        res.send('Invalid state parameter.');
        return;
    }

    const {session, user} = stateDecoded;

     if (!sessions[session]) {
        res.send('Invalid session.');
        return;
    }

    const authOptions = {
        url: 'https://accounts.spotify.com/api/token',
        form: {
            code: code,
            redirect_uri: process.env.SPOTIFY_REDIRECT_URI,
            grant_type: 'authorization_code',
        },
        headers: {
            Authorization: 'Basic ' + Buffer.from(
                process.env.SPOTIFY_CLIENT_ID + ':' + process.env.SPOTIFY_CLIENT_SECRET
            ).toString('base64')
        },
        json: true
    };

    request.post(authOptions, (error, response, body) => {
        if(!error && response.statusCode == 200){
            // Save tokens in session storage
            sessions[session][`user${user}Tokens`] = {
                access_token: body.access_token,
                refresh_token: body.refresh_token,
            };

            const user1 = sessions[session].user1Tokens;
            const user2 = sessions[session].user2Tokens;

            if(user1 && user2){
                //both logged in
                res.send(`
                    <h1>Both users logged in!</h1>
                    <p>Session: ${session}</p>
                    <p>Now you can fetch data and generate the playlist.</p>
                    <a href="/logout?session=${session}">Logout and clear session</a>
                `);
            }
            else{
                // Only one user logged in so far — send the share link to friend
                const nextUser = user === '1' ? '2' : '1';
                const shareLink = `${process.env.BASE_URL}/login?session=${session}&user=${nextUser}`;


                res.send(`
                    <h1>User ${user} logged in!</h1>
                    <p>Send this link to your friend so they can log in:</p>
                    <a href="${shareLink}">${shareLink}</a>
                `);
            }
        }
        else{
            console.error('Token Error:', error);
            console.error('Response:', body);
            res.send(`
                <h1>Failed to get access token</h1>
                <pre>${JSON.stringify(body, null, 2)}</pre>
            `);
            res.send("Failed to get access token.");
        }
    });
});

app.listen(port, () => {
    console.log(`Server listening at http://localhost:${port}`);
});

app.get('/logout', (req, res) => {
  const sessionId = req.query?.session;

  if (sessionId && sessions[sessionId]) {
    delete sessions[sessionId];
    res.send(`
      <h1>Logged out</h1>
      <p>Session <code>${sessionId}</code> has been cleared.</p>
      <a href="/">Back to home</a>
    `);
  } else {
    res.send(`
      <h1>Nothing to log out</h1>
      <p>Session not found or already cleared.</p>
      <a href="/">Back to home</a>
    `);
  }
});

app.get('generate', (req, res) => {
    const sessionid = req.query.session;

    if(!sessionid || !sessions[session]){
        return res.send('<h1>Invalid session ID</h1>');
    }

    const user1 = sessions[sessionid].user1Tokens;
    const user2 = sessions[sessionid].user2Tokens;

    if(!user1 || !user2){
        return res.send('<h1>Both users must be logged in</h1>');
    }

    const user1Stats = {
        url: 'https://api.spotify.com/v1/me/top/tracks?limit=50&time_range=medium_term',
        headers: { Authorization: 'Bearer ' + user1.access_token },
        json: true
    };

    const user2Stats = {
        url: 'https://api.spotify.com/v1/me/top/tracks?limit=50&time_range=medium_term',
        headers: {Authorization: 'Bearer ' + user2.access_token},
        json: true
    };

    //get top tracks
    request.get(user1Stats, (err1, resp1, body1) => {
        if(err1 || resp1.statusCode !== 200){
            return res.send('<h1>Failed to fetch User 1 tracks</h1>');
        }

        request.get(user2Stats, (err2, resp2, body2) => {
            if(err2 || resp2.statusCode !== 200){
                return res.send('<h1>Failed to fetch User 2 tracks.</h2>');
            }
            
            const user1Tracks = body1.items.map(track => track.id);
            const user2Tracks = body2.items.map(track => track.id);

            const sharedTracks = user1Tracks.filter(id => user2Tracks.includes(id));

            if(sharedTracks.length == 0){
                return res.send('<h1>No Overlapping Tracks Found');
            }

            else{
                const sharedInfo = body1.items
                .filter(track => sharedTracks.includes(track.id))
                .map(track => `<li>${track.name} by ${track.artists.map(a => a.name).join(', ')}</li>`)
                .join(' ');

                res.send(`
                    <h1>🎶 Shared Top Tracks</h1>
                    <ul>${sharedInfo}</ul>
                    <p><strong>Total:</strong> ${sharedTracks.length} tracks</p>
                `);
            }

        });
    });
});