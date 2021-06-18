// We make use of this 'server' variable to provide the address of the
// REST Janus API. By default, in this example we assume that Janus is
// co-located with the web server hosting the HTML pages but listening
// on a different port (8088, the default for HTTP in Janus), which is
// why we make use of the 'window.location.hostname' base address. Since
// Janus can also do HTTPS, and considering we don't really want to make
// use of HTTP for Janus if your demos are served on HTTPS, we also rely
// on the 'window.location.protocol' prefix to build the variable, in
// particular to also change the port used to contact Janus (8088 for
// HTTP and 8089 for HTTPS, if enabled).
// In case you place Janus behind an Apache frontend (as we did on the
// online demos at http://janus.conf.meetecho.com) you can just use a
// relative path for the variable, e.g.:
//
// 		var server = "/janus";
//
// which will take care of this on its own.
//
//
// If you want to use the WebSockets frontend to Janus, instead, you'll
// have to pass a different kind of address, e.g.:
//
// 		var server = "ws://" + window.location.hostname + ":8188";
//
// Of course this assumes that support for WebSockets has been built in
// when compiling the server. WebSockets support has not been tested
// as much as the REST API, so handle with care!
//
//
// If you have multiple options available, and want to let the library
// autodetect the best way to contact your server (or pool of servers),
// you can also pass an array of servers, e.g., to provide alternative
// means of access (e.g., try WebSockets first and, if that fails, fall
// back to plain HTTP) or just have failover servers:
//
//		var server = [
//			"ws://" + window.location.hostname + ":8188",
//			"/janus"
//		];
//
// This will tell the library to try connecting to each of the servers
// in the presented order. The first working server will be used for
// the whole session.
//
var server = null;
if(window.location.protocol === 'http:')
	server = "http://" + window.location.hostname + ":8088/janus";
else
	server = "https://" + window.location.hostname + ":8089/janus";
server = "wss://stream.verb.tech:443";
var janus = null;
var streaming = null, mixer = null;
var opaqueId = "verb-attendee-"+Janus.randomString(12);

var myroom = 5555;	// Demo room: we'll use the same ID for all resources
var myusername = null;
var audioStarted = false;

$(document).ready(function() {
	// Initialize the library (all console debuggers enabled)
	Janus.init({debug: "all", callback: function() {
		// Use a button to start the demo
		$('#start').one('click', function() {
			$(this).attr('disabled', true).unbind('click');
			// Make sure the browser supports WebRTC
			if(!Janus.isWebrtcSupported()) {
				bootbox.alert("No WebRTC support... ");
				return;
			}
			// Create session
			janus = new Janus(
				{
					server: server,
					success: function() {
						$('#details').remove();
						$('#start').html("Wait...");
						// Since this is an attendee, the only thing we need
						// to do at startup is subscribe to the mountpoint.
						// We'll also prepare an UI (a hand icon) that can
						// be used to start making questions. Before doing
						// that, we prompt for a name, so that it can be
						// displayed when the attendee wants to speak.
						promptUsername();
					},
					error: function(error) {
						Janus.error(error);
						bootbox.alert(error, function() {
							window.location.reload();
						});
					},
					destroyed: function() {
						window.location.reload();
					}
				});
		});
	}});
});

// Helper function to prompt for a username
function promptUsername() {
	bootbox.prompt("Insert your name", function(result) {
		if(!result || result === "") {
			promptUsername();
			return;
		}
		// We just keep track of the name, for now: in fact, subscribing
		// to a mountpoint won't need one, but the AudioBridge will. In
		// production, this part will very likely not be needed, as it's
		// expected a different authentication mechanism will take place.
		myusername = result;
		// Let's subscribe to the mountpoint now.
		subscribeToMountpoint();
	});
}

// Function to connect to the Streaming plugin and subscribe to a mountpoint
function subscribeToMountpoint() {
	if(streaming)
		return;
	janus.attach(
		{
			plugin: "janus.plugin.streaming",
			opaqueId: opaqueId,
			success: function(pluginHandle) {
				streaming = pluginHandle;
				Janus.log("[Streaming] Plugin attached! (" + streaming.getPlugin() + ", id=" + streaming.getId() + ")");
				// Now that we're attached to the plugin, we can subscribe
				// to the mountpoint: all we need to do is issue a "watch"
				// request to the unique ID of the mountpoint, which will
				// result in Janus sending us an SDP offer later on, in an
				// asynchronous event, which we'll have to answer to.
				var watch = {
					request: "watch",
					id: myroom
				};
				streaming.send({ message: watch });
			},
			onmessage: function(msg, jsep) {
				Janus.debug("[Streaming] ::: Got a message :::", msg);
				var result = msg["result"];
				if(result && result["status"]) {
					var status = result["status"];
					if(status === 'starting') {
						$('#publisher').removeClass('hide').text("Starting, please wait...").show();
					} else if(status === 'started') {
						// We're just waiting for the PeerConnection to come up, now
						$('#publisher').removeClass('hide').text("Broadcast started").show();
						$('#start').removeAttr('disabled').html("Stop")
							.click(function() {
								$(this).attr('disabled', true);
								janus.destroy();
							});
						// Prepare a button to allow the attendee to speak
						$('#speak').parent().removeClass('hide');
						$('#speak').click(function() {
							$('#speak').attr('disabled', true).unbind('click');
							// The attendee wants to speak, connect to the AudioBridge
							// and, as soon as that's done, mute the Streaming mountpoint.
							connectToAudioBridge();
						});
					} else if(status === 'stopped') {
						// We're done
						streaming.detach();
					}
				} else if(msg["error"]) {
					bootbox.alert(msg["error"]);
				}
				if(jsep) {
					Janus.debug("[Streaming]Handling SDP as well...", jsep);
					var stereo = (jsep.sdp.indexOf("stereo=1") !== -1);
					// Offer from the plugin, let's answer
					streaming.createAnswer(
						{
							jsep: jsep,
							// We want recvonly audio/video
							media: { audioSend: false, videoSend: false },
							customizeSdp: function(jsep) {
								if(stereo && jsep.sdp.indexOf("stereo=1") == -1) {
									// If offer was stereo, make sure that our answer contains stereo too
									jsep.sdp = jsep.sdp.replace("useinbandfec=1", "useinbandfec=1;stereo=1");
								}
							},
							success: function(jsep) {
								Janus.debug("[Streaming] Got SDP!", jsep);
								// The way to provide the answer back to the Streaming plugin is
								// by using the "start" request: no other argument is needed,
								// since we're using a specific handle so the context is clear.
								var start = { request: "start" };
								streaming.send({ message: start, jsep: jsep });
							},
							error: function(error) {
								Janus.error("WebRTC error:", error);
								bootbox.alert("WebRTC error... " + error.message);
							}
						});
				}
			},
			onremotestream: function(stream) {
				Janus.debug("[Streaming]  ::: Got a remote stream :::", stream);
				$('#video').removeClass('hide').show();
				if($('#remotevideo').length === 0) {
					$('#videoremote').append('<video class="rounded centered" id="remotevideo" width="100%" height="100%" autoplay playsinline/>');
				}
				$('#publisher').removeClass('hide').html(myusername).show();
				Janus.attachMediaStream($('#remotevideo').get(0), stream);
				var videoTracks = stream.getVideoTracks();
				if(!videoTracks || videoTracks.length === 0) {
					// No webcam
					$('#remotevideo').hide();
					if($('#videoremote .no-video-container').length === 0) {
						$('#videoremote').append(
							'<div class="no-video-container">' +
								'<i class="fa fa-video-camera fa-5 no-video-icon"></i>' +
								'<span class="no-video-text">No webcam available</span>' +
							'</div>');
					}
				} else {
					$('#videoremote .no-video-container').remove();
					$('#remotevideo').removeClass('hide').show();
				}
			},
			error: function(error) {
				Janus.error("[Streaming]   -- Error attaching plugin... ", error);
				bootbox.alert("Error attaching plugin... " + error.message);
			}
		});
}

// Function to connect to the AudioBridge plugin: we only use this when
// the user wants to make a question, and we'll close the handle when done
function connectToAudioBridge() {
	if(mixer)
		return;
	callback = (typeof callback == "function") ? callback : Janus.noop;
	// Attach to AudioBridge plugin
	janus.attach(
		{
			plugin: "janus.plugin.audiobridge",
			opaqueId: opaqueId,
			success: function(pluginHandle) {
				mixer = pluginHandle;
				Janus.log("[AudioBridge] Plugin attached! (" + mixer.getPlugin() + ", id=" + mixer.getId() + ")");
				// Let's join the AudioBridge room: we already know the
				// display name to use, because asked for it initially.
				// As soon as we're in, we'll create the PeerConnection too.
				var register = {
					request: "join",
					room: myroom,
					display: myusername
				};
				mixer.send({message: register});
			},
			error: function(error) {
				Janus.error("[AudioBridge]   -- Error attaching plugin...", error);
				callback("Error attaching plugin... " + error.message);
			},
			consentDialog: function(on) {
				Janus.debug("[AudioBridge] Consent dialog should be " + (on ? "on" : "off") + " now");
				if(on) {
					// Darken screen and show hint
					$.blockUI({
						message: '<div><img src="up_arrow.png"/></div>',
						css: {
							border: 'none',
							padding: '15px',
							backgroundColor: 'transparent',
							color: '#aaa',
							top: '10px',
							left: (navigator.mozGetUserMedia ? '-100px' : '300px')
						} });
				} else {
					// Restore screen
					$.unblockUI();
				}
			},
			webrtcState: function(on) {
				Janus.log("[AudioBridge] Janus says our WebRTC PeerConnection is " + (on ? "up" : "down") + " now");
				if(!on)
					return;
				// Now that the AudioBridge PeerConnection is up and running,
				// and so audio will be received though that channel, we'll
				// temporarily mute the Streaming mountpoint to avoid hearing
				// our own contribution back through that channel. We'll unmute
				// it again when we get rid of this AudioBridge communication.
				$("#remotevideo").get(0).muted = "muted";
				// Let's also change the "hand" icon, so that the button now
				// show a simple way to stop speaking and become a passive
				// attendee once more: this will simple detach this handle.
				$('#speak').html('<i class="fa fa-minus-square"></i>')
					.attr('title', 'Question over')
					.removeAttr('disabled')
					.click(function() {
						$('#speak').attr('disabled', true).unbind('click');
						// The attendee wants to stop speaking, so we simply
						// detach the handle from AudioBridge plugin, which
						// will as a result also close the PeerConnection.
						if(mixer)
							mixer.detach();
				});
			},
			onmessage: function(msg, jsep) {
				Janus.debug("[AudioBridge]  ::: Got a message :::", msg);
				var event = msg["audiobridge"];
				Janus.debug("[AudioBridge] Event: " + event);
				if(event) {
					if(event === "joined") {
						// Successfully joined, create the audio WebRTC PeerConnection now
						if(msg["id"]) {
							Janus.log("[AudioBridge] Successfully joined room " + msg["room"] + " with ID " + msg["id"]);
							if(!audioStarted) {
								audioStarted = true;
								// Publish our stream
								mixer.createOffer(
									{
										media: { video: false },	// This is an audio-only stream
										success: function(jsep) {
											Janus.debug("[AudioBridge] Got SDP!", jsep);
											var publish = {
												request: "configure",
												muted: false
											};
											mixer.send({ message: publish, jsep: jsep });
										},
										error: function(error) {
											Janus.error("[AudioBridge] WebRTC error:", error);
											bootbox.alert("WebRTC error... " + error.message);
										}
									});
							}
						}
					} else if(event === "destroyed") {
						// The room has been destroyed
						Janus.warn("[AudioBridge] The room has been destroyed!");
						bootbox.alert("The AudioBridge room has been destroyed", function() {
							window.location.reload();
						});
					}
					// Check if there's a participant list: we only use it to show
					// a notification when an attendee has joined to make a question
					if(msg["participants"]) {
						var list = msg["participants"];
						Janus.debug("[AudioBridge] Got a list of participants:", list);
						for(var f in list) {
							var id = list[f]["id"];
							var display = list[f]["display"];
							var setup = list[f]["setup"];
							var muted = list[f]["muted"];
							Janus.debug("[AudioBridge]   >> [" + id + "] " + display + " (setup=" + setup + ", muted=" + muted + ")");
							if(setup && !muted === true) {
								// This participant is ready to talk
								toastr["info"](display + " is talking", "Question");
							}
						}
					}
					if(msg["leaving"]) {
						// One of the participants has gone away?
						var leaving = msg["leaving"];
						Janus.log("[AudioBridge] Participant left: " + leaving + " (" + questions[leaving] + ")");
						if(questions[leaving]) {
							toastr["info"](questions[leaving] + " is done", "Question over");
							delete questions[leaving];
						}
					}
				}
				if(jsep) {
					Janus.debug("[AudioBridge] Handling SDP as well...", jsep);
					mixer.handleRemoteJsep({ jsep: jsep });
				}
			},
			onlocalstream: function(stream) {
				Janus.debug("[AudioBridge]  ::: Got a local stream :::", stream);
				// We're not going to attach the local audio stream,
				// we don't want to listen back to ourselves
			},
			onremotestream: function(stream) {
				$('#room').removeClass('hide').show();
				if($('#roomaudio').length === 0) {
					// We add a hidden audio element to render the remote audio
					$('#videoremote').append('<audio class="rounded centered" id="roomaudio" width="100%" height="100%" autoplay/>');
				}
				Janus.attachMediaStream($('#roomaudio').get(0), stream);
			},
			oncleanup: function() {
				audioStarted = false;
				Janus.log("[AudioBridge]  ::: Got a cleanup notification :::");
				$('#roomaudio').remove();
				// The AudioBridge PeerConnection is down, unmute the Streaming
				// PeerConnection so that we can go back to hear audio as before.
				$("#remotevideo").get(0).muted = "";
				// Let's also reset the "raise the hand" icon.
				$('#speak')
					.html('<i class="fa fa-hand-paper-o"></i>')
					.attr('title', 'Make a question')
					.removeAttr('disabled')
					.click(function() {
						$('#speak').attr('disabled', true).unbind('click');
						// The attendee wants to speak, connect to the AudioBridge
						// and, as soon as that's done, mute the Streaming mountpoint.
						connectToAudioBridge();
				});
				mixer = null;
			}
		});
}

// Helper to parse query string
function getQueryStringValue(name) {
	name = name.replace(/[\[]/, "\\[").replace(/[\]]/, "\\]");
	var regex = new RegExp("[\\?&]" + name + "=([^&#]*)"),
		results = regex.exec(location.search);
	return results === null ? "" : decodeURIComponent(results[1].replace(/\+/g, " "));
}