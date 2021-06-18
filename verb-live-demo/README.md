# START verb-live-backend docker container

# START demo app to connect to local container
### Edit the server settings in speaker.js and attendee.js to your docker container settings
```
server = "wss://stream.verb.tech:8189";
```

### Start local web server, use one or the other below, depending on your version of python
```
python -m http.server
OR
python -m SimpleHTTPServer
```
