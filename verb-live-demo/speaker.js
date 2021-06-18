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
var publisher = null, mixer = null, streaming = null;
var opaqueId = "verb-speaker-"+Janus.randomString(12);

var myroom = 5555;	// Demo room: we'll use the same ID for all resources
var myusername = null;
var myid = null;
var mystream = null, screenStream = null;
var audioStarted = false;
var fwdInfo = null;
var questions = {};

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
						// Since this is a demo, we start by creating all the resources
						// we need, so the VideoRoom room, the AudioBridge room, and
						// the Streaming mountpoint. As soon as those are ready, we
						// prompt the speaker for a username, to join and publish media.
						// Normally, you'll want resources to be created on the server
						// side instead, so that all the user code needs to do is just
						// take care of publishing the streams and nothing else.
						createResources();
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

// Helper function to create the resources we need
function createResources() {
	// We'll need a handle to connect to the Streaming plugin (that we'll
	// get rid of after we've created the mountpoint), a handle to connect
	// to the AudioBridge (that we'll keep since we need to also join the
	// audio room) and a handle to connect to the VideoRoom (which we'll
	// also keep as we need it to publish our webcam and/or screen). To
	// keep things simple we'll do these operation in sequence, so we'll
	// start with the Streaming mountpoint, then AudioBridge room, and
	// finally VideoRoom room. In a more complex application, you may want
	// to create the Streaming plugin last, e.g., if you don't know which
	// video codec the speaker will end up using; if you're forcing a
	// specific codec, it's easier to create the mountpoint first.
	connectToStreaming(function(err, result) {
		if(err) {
			// Something went wrong
			bootbox.alert(err);
			return;
		}
		// Take note of the mountpoint details: we'll need them later,
		// when we'll have to RTP-forward audio and video there
		fwdInfo = result;
		// Now that we have our mountpoint, let's connect to the AudioBridge:
		// the only thing we'll do once connected will be creating a new
		// AudioBridge room, and then we'll wait before actually joining it.
		connectToAudioBridge(function(err, result) {
			if(err) {
				// Something went wrong
				bootbox.alert(err);
				return;
			}
			// Finally, we can connect to the VideoRoom: we'll start by
			// creating the VideoRoom, and as soon as that's done we'll
			// show the prompt to ask for the user name. When a name has
			// been provided, we can finally join and publish media.
			connectToVideoRoom();
		});
	});
}

// Function to connect to the Streaming plugin and create a mountpoint
function connectToStreaming(callback) {
	if(streaming)
		return;
	callback = (typeof callback == "function") ? callback : Janus.noop;
	janus.attach(
		{
			plugin: "janus.plugin.streaming",
			opaqueId: opaqueId,
			success: function(pluginHandle) {
				streaming = pluginHandle;
				Janus.log("[Streaming] Plugin attached! (" + streaming.getPlugin() + ", id=" + streaming.getId() + ")");
				// Now that we're attached to the plugin, we can create the mountpoint.
				// There are several properties you can specify to create a mountpoint
				// dynamically, but obviously the most important ones are related to
				// what audio and video will look like. Let's assume audio will be
				// Opus and video VP8; besides, let's make the plugin pick random ports
				// for RTP too (note: you may need to configure the Streaming plugin
				// port range so that it doesn't overlap with the one in janus.jcfg)
				var create = {
					request: "create",
					id: myroom,						// We'll use the room ID for the mountpoint too
					type: "rtp",					// We need an RTP mountpoint
					audio: true,					// We do want audio
					audiopt: 100,					// Use 100 as payload type
					audiortpmap: "opus/48000/2",	// This is the Opus RTP map
					audioport: 0,					// Pick a random port for audio RTP (we'll get it in the response)
					video: true,					// We want video too
					videopt: 96,					// Use 96 as payload type
					videortpmap: "VP8/90000",		// This is the VP8 RTP map
					videoport: 0,					// Pick a random port for video RTP (we'll get it in the response)
					videortcpport: 0,				// Pick a random port for video RTCP (we'll get it in the response)
					secret: "verysecret"			// Only who knows the secret can edit/destroy
				};
				// "create" is a synchronous request, so we'll receive a response here
				streaming.send({
					message: create,
					success: function(result) {
						// Let's check the response: if the mountpoint was
						// created successfully, we send back the details.
						// If the mountpoint exists already, though (e.g.,
						// the speaker refreshed the page), we send another
						// request to get the info we need.
						if(result.error) {
							// Send an info request for the mountpoint
							var info = {
								request: "info",		// Get info on the mountpoint
								id: myroom,				// We know the ID of the mountpoint
								secret: "verysecret"	// Ports will only be returned if the secret is provided
							};
							streaming.send({
								message: info,
								success: function(result) {
									if(result.info) {
										// Mountpoint details retrieved successfully, prepare the info
										var mountpointInfo = {
											id: result.info.id,						// This is the unique mountpoint ID
											host: 'localhost',			// We know the address of Janus already
											audioPort: result.info.audioport,		// Port to send audio to
											videoPort: result.info.videoport,		// Port to send video to
											rtcpPort: result.info.videortcpport		// Port for RTCP latching
										};
										callback(null, mountpointInfo);
									} else {
										// Couldn't get the info?
										Janus.error("[Streaming] Error creating Streaming mountpoint... ", info);
										callback("Error creating Streaming mountpoint");
									}
									// We don't need this handle anymore, get rid of it
									streaming.detach();
								}
							});
							return;
						}
						// Mountpoint created successfully, prepare the info
						var mountpointInfo = {
							id: result.stream.id,						// This is the unique mountpoint ID
							host: 'localhost',			             	// We know the address of Janus already
							audioPort: result.stream.audio_port,		// Port to send audio to
							videoPort: result.stream.video_port,		// Port to send video to
							rtcpPort: result.stream.video_rtcp_port		// Port for RTCP latching
						};
						callback(null, mountpointInfo);
						// We don't need this handle anymore, get rid of it
						streaming.detach();
					}
				});
			},
			error: function(error) {
				Janus.error("[Streaming]   -- Error attaching plugin... ", error);
				callback("Error attaching plugin... " + error.message);
			}
		});
}

// Function to connect to the AudioBridge plugin
function connectToAudioBridge(callback) {
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
				// We're connected to the plugin: let's create the AudioBridge
				// room, and then notify the callback. We'll join later,
				// when all rooms are ready and we have the speaker's name.
				// Just as for mountpoints, creating an AudioBridge is a
				// synchronous request, so we'll get a response right away.
				// For simplicity, we'll create a room with the defaults.
				// Notice you can also configure forwarders only later.
				// If we get an error saying the room exists, we'll treat
				// it as a success, since all we need is a room to join.
				var create = {
					request: "create",
					room: myroom,							// Specify the room ID we want to use
					secret: "verysecret"					// Only who knows the secret can edit/destroy
				};
				// "create" is a synchronous request, so we'll receive a response here
				mixer.send({
					message: create,
					success: function(result) {
						// Let's check the response: it's a success if
						// we don't receive an error, or if the error
						// we get back is 486 (room exists).
						if(!result.error || result.error_code == 486) {
							// Room created/available, let's move on. First, though,
							// let's pre-configure the room to RTP-forward the audio
							// as soon as the first user (that is, the speaker) joins.
							// We only do that if the room didn't exist before, as
							// otherwise we did it already and doing it again would
							// cause the same packets to be sent twice and cause a mess.
							if(result.error_code === 486) {
								// We're done
								callback(null);
							} else {
								// Configure the RTP forwarder
								mixer.send({
									message: {
										request: "rtp_forward",
										room: myroom,					// ID of the AudioBridge room
										secret: "verysecret",			// Secret of the room (that's why users shouldn't send this!)
										host: "localhost",				// IP address of the mountpoint
										host_family: "ipv4",			// Let's just assume it's an IPv4 address
										port: fwdInfo.audioPort,		// Audio port of the mountpoint
										always_on: false				// Don't forward if the room is empty
									}, success: function(result) {
										// Let's make sure everything went fine
										if(result.error) {
											Janus.error("Error forwarding audio:", result.error);
											callback("Error forwarding audio: " + result.error);
										} else {
											// We're done
											callback(null);
										}
									}
								});
							}
						} else {
							// A different error occurred
							Janus.error("[AudioBridge] Error creating AudioBridge room... ", result.error);
							callback("Error creating AudioBridge room... " + result.error);
						}
					}
				});
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
								questions[id] = display;
							}
						}
					}
					if(msg["leaving"]) {
						// One of the participants has gone away?
						var leaving = msg["leaving"];
						Janus.log("[AudioBridge] Participant left: " + leaving + " (" + questions[leaving] + ")");
						if(questions[leaving]) {
							toastr["info"](questions[leaving] + " is done", "Done");
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
					$('#videolocal').append('<audio class="rounded centered" id="roomaudio" width="100%" height="100%" autoplay/>');
				}
				Janus.attachMediaStream($('#roomaudio').get(0), stream);
			},
			oncleanup: function() {
				audioStarted = false;
				Janus.log("[AudioBridge]  ::: Got a cleanup notification :::");
				$('#roomaudio').remove();
			}
		});
}

// Function to connect to the VideoRoom plugin
function connectToVideoRoom() {
	if(publisher)
		return;
	// Attach to VideoRoom plugin
	janus.attach(
		{
			plugin: "janus.plugin.videoroom",
			opaqueId: opaqueId,
			success: function(pluginHandle) {
				publisher = pluginHandle;
				Janus.log("[VideoRoom] Plugin attached! (" + publisher.getPlugin() + ", id=" + publisher.getId() + ")");
				// We're connected to the plugin: let's complete the setup
				// of the resources by creating the VideoRoom room too. If
				// that succeeds, we'll show the prompt to the speaker,
				// so that they can actually join the rooms and publish.
				var create = {
					request: "create",
					room: myroom,					// Specify the room ID we want to use
					publishers: 1,					// We only want one active publisher, the speaker
					bitrate: 500000,				// As an example, we cap the bitrate to 500kbps (0 disables the limits)
					audiocodec: "opus",				// Let's force Opus for audio
					videocodec: "vp8",				// Let's force VP8 for video
					transport_wide_cc_ext: true,	// Enable the sender-side bandwidth estimation
					fir_freq: 10,					// Let's ask for a keyframe every 10s or so
					secret: "verysecret"			// Only who knows the secret can edit/destroy
				};
				// "create" is a synchronous request, so we'll receive a response here
				publisher.send({
					message: create,
					success: function(result) {
						// Let's check the response: it's a success if
						// we don't receive an error, or if the error
						// we get baxk is 427 (room exists).
						if(!result.error || result.error_code == 427) {
							// Room created/available, let's get started
							$('#start').removeAttr('disabled').html("Stop")
								.click(function() {
									$(this).attr('disabled', true);
									janus.destroy();
								});
							promptUsername();
						} else {
							// A different error occurred
							Janus.error("[VideoRoom] Error creating VideoRoom room... ", result.error);
							bootbox.alert("Error creating VideoRoom room... " + result.error);
						}
					}
				});
			},
			error: function(error) {
				Janus.error("[VideoRoom]   -- Error attaching plugin...", error);
				bootbox.alert("Error attaching plugin... " + error.message);
			},
			consentDialog: function(on) {
				Janus.debug("[VideoRoom] Consent dialog should be " + (on ? "on" : "off") + " now");
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
				Janus.log("[VideoRoom] Janus says our WebRTC PeerConnection is " + (on ? "up" : "down") + " now");
				$("#videolocal").parent().parent().unblock();
				if(!on)
					return;
				// Now that the PeerConnection is up and running, we can tell
				// the plugin to forward the media to the Streaming mountpoint:
				// we took note of video and RTCP ports before, and use them here.
				// It is a synchronous request, so we'll get the answer right away.
				// Again, this is done here for the sake of simplicity and as a
				// demonstration, but just as creating rooms and mountpoints,
				// this is an operation that should be only performed by an
				// authorized component on the server side: in fact, this
				// results in Janus sending UDP packets to an address specified
				// in the request, meaning it could be easily abused to, e.g.,
				// send a lot of UDP traffic to an address as an attack.
				publisher.send({
					message: {
						request: "rtp_forward",
						room: myroom,						// ID of the VideoRoom room
						publisher_id: myid,					// ID of the VideoRoom publisher
						secret: "verysecret",				// Secret of the room (that's why users shouldn't send this!)
						host: "localhost",					// IP address of the mountpoint
						host_family: "ipv4",				// Let's just assume it's an IPv4 address
						video_port: fwdInfo.videoPort,		// Video port of the mountpoint
						video_rtcp_port: fwdInfo.rtcpPort	// Video RTCP port of the mountpoint (needed for keyframes)
					}, success: function(result) {
						// Let's make sure everything went fine
						if(result.error) {
							Janus.error("Error forwarding video:", result.error);
							bootbox.alert("Error forwarding video: " + result.error);
						}
					}
				});
				// Let's also prepare a button to share the screen instead
				$('#share').parent().removeClass('hide');
				$('#share').click(function() {
					$('#share').attr('disabled', true).unbind('click');
					// Let's show the screen sharing dialog
					changeVideoTo("screen");
				});
			},
			onmessage: function(msg, jsep) {
				Janus.debug("[VideoRoom]  ::: Got a message :::", msg);
				var event = msg["videoroom"];
				Janus.debug("[VideoRoom] Event: " + event);
				if(event) {
					if(event === "joined") {
						// Successfully joined, create the audio WebRTC PeerConnection now
						myid = msg["id"];
						Janus.log("[VideoRoom] Successfully joined room " + msg["room"] + " with ID " + myid);
						publisher.createOffer(
							{
								media: { audio: false, videoRecv: false, videoSend: true },	// We only send video
								success: function(jsep) {
									Janus.debug("[VideoRoom] Got publisher SDP!", jsep);
									var publish = {
										request: "configure",
										video: true
									};
									publisher.send({ message: publish, jsep: jsep });
								},
								error: function(error) {
									Janus.error("[VideoRoom] WebRTC error:", error);
									bootbox.alert("WebRTC error... " + error.message);
								}
							});

						// We ignore other feeds in this demo
					} else if(event === "destroyed") {
						// The room has been destroyed
						Janus.warn("[VideoRoom] The room has been destroyed!");
						bootbox.alert("The room has been destroyed", function() {
							window.location.reload();
						});
					}
				}
				if(jsep) {
					Janus.debug("[VideoRoom] Handling SDP as well...", jsep);
					publisher.handleRemoteJsep({jsep: jsep});
					// Check if any of the media we wanted to publish has
					// been rejected (e.g., wrong or unsupported codec)
					var audio = msg["audio_codec"];
					if(mystream && mystream.getAudioTracks() && mystream.getAudioTracks().length > 0 && !audio) {
						// Audio has been rejected
						toastr.warning("Our audio stream has been rejected, viewers won't hear us");
					}
					var video = msg["video_codec"];
					if(mystream && mystream.getVideoTracks() && mystream.getVideoTracks().length > 0 && !video) {
						// Video has been rejected
						toastr.warning("Our video stream has been rejected, viewers won't see us");
						// Hide the webcam video
						$('#myvideo').hide();
						$('#videolocal').append(
							'<div class="no-video-container">' +
								'<i class="fa fa-video-camera fa-5 no-video-icon" style="height: 100%;"></i>' +
								'<span class="no-video-text" style="font-size: 16px;">Video rejected, no webcam</span>' +
							'</div>');
					}
				}
			},
			onlocalstream: function(stream) {
				Janus.debug("[VideoRoom]  ::: Got a local stream :::", stream);
				mystream = stream;
				$('#video').removeClass('hide').show();
				if($('#myvideo').length === 0) {
					$('#videolocal').append('<video class="rounded centered" id="myvideo" width="100%" height="100%" autoplay playsinline muted="muted"/>');
				}
				$('#publisher').removeClass('hide').html(myusername).show();
				Janus.attachMediaStream($('#myvideo').get(0), stream);
				$("#myvideo").get(0).muted = "muted";
				if(publisher.webrtcStuff.pc.iceConnectionState !== "completed" &&
						publisher.webrtcStuff.pc.iceConnectionState !== "connected") {
					$("#videolocal").parent().parent().block({
						message: '<b>Publishing...</b>',
						css: {
							border: 'none',
							backgroundColor: 'transparent',
							color: 'white'
						}
					});
				}
				var videoTracks = stream.getVideoTracks();
				if(!videoTracks || videoTracks.length === 0) {
					// No webcam
					$('#myvideo').hide();
					if($('#videolocal .no-video-container').length === 0) {
						$('#videolocal').append(
							'<div class="no-video-container">' +
								'<i class="fa fa-video-camera fa-5 no-video-icon"></i>' +
								'<span class="no-video-text">No webcam available</span>' +
							'</div>');
					}
				} else {
					$('#videolocal .no-video-container').remove();
					$('#myvideo').removeClass('hide').show();
				}
			},
			onremotestream: function(stream) {
				// The publisher stream is sendonly, we don't expect anything here
			},
			oncleanup: function() {
				Janus.log("[VideoRoom]  ::: Got a cleanup notification: we are unpublished now :::");
				$('#myvideo').remove();
				$('.no-video-container').remove();
			}
		});
}

// Helper function to prompt for a username and join the rooms
function promptUsername() {
	bootbox.prompt("Insert your name", function(result) {
		if(!result || result === "") {
			promptUsername();
			return;
		}
		// Join both the VideoRoom and the AudioBridge rooms: as soon as we've
		// joined (event received), we'll start sending our media there too.
		// For the sake of simplicity, we use the same request for both, since
		// the APIs to join are very similar (AudioBridge will ignore 'ptype').
		myusername = result;
		var register = {
			request: "join",
			room: myroom,
			ptype: "publisher",
			display: myusername
		};
		publisher.send({message: register});
		mixer.send({message: register});
	});
}

// Helper function to switch the content of the video we're sending. By
// default, we publish the webcam, but we allow the speaker to switch to
// screensharing and back to the webcam dynamically. To do that, we use
// a WebRTC function called replaceTrack(), which allows us to replace
// the source of a stream without needing to renegotiate the session.
var current = "webcam";
function changeVideoTo(source) {
	if(source === current)
		return;
	if(source === "screen") {
		// We were sharing our webcam, switch to our screen or one of the
		// applications on our desktop. We need to call getDisplayMedia()
		// to let the user pick what exactly they want to share now.
		navigator.mediaDevices.getDisplayMedia({ video: true, audio: false })
			.then(function(stream) {
				Janus.debug("[VideoRoom]  ::: Got a screenshare stream :::", stream);
				screenStream = stream;
				// Let's get the video track from this new stream
				var track = screenStream.getVideoTracks()[0];
				// Now let's access the publisher's video sender: it's
				// easy as this PeerConnection only has a single stream,
				// since audio is sent using a different channel instead.
				var sender = publisher.webrtcStuff.pc.getSenders()[0];
				// Now let's replace the video track in the sender: as
				// a consequence, attendees will automatically start
				// seeing the screen/application instead of the webcam.
				sender.replaceTrack(track);
				current = "screen";
				// Let's also darken the local video, since it's not
				// really what we're sharing (and showing a preview of
				// the screen would just look messy and useless).
				$("#videolocal").block({
					message: '<b>Screensharing active...</b>',
					css: {
						border: 'none',
						backgroundColor: 'transparent',
						color: 'white'
					}
				});
				// Change the screensharing icon too, to allow the speaker
				// to change back to their webcam whenever they want.
				$('#share').html('<i class="fa fa-video-camera"></i>')
					.attr('title', 'Switch to webcam')
					.removeAttr('disabled')
					.click(function() {
						$('#share').attr('disabled', true).unbind('click');
						// Let's to back to the webcam
						changeVideoTo("webcam");
					});
			}, function (error) {
				Janus.error("Error switching to screensharing...", error);
				bootbox.alert("Error switching to screensharing... " + error.message);
			});
	} else if(source === "webcam") {
		// We were sharing our screen or an application, and want to go
		// back to our webcam. Since we still have the origina stream
		// (that we didn't close previously), we simply configure the
		// PeerConnection sender to switch back to that instead.
		var track = mystream.getVideoTracks()[0];
		// Now let's access the publisher's video sender: it's
		// easy as this PeerConnection only has a single stream,
		// since audio is sent using a different channel instead.
		var sender = publisher.webrtcStuff.pc.getSenders()[0];
		// Now let's replace the video track in the sender: as a
		// consequence, attendees will automatically start seeing out
		// webcam again, instead of the screen they were getting before.
		sender.replaceTrack(track);
		// Let's get rid of the screensharing stream, we don't need it
		// anymore: if the user wants to share the screen again later,
		// we'll get a new one, as they may want to share something
		// different this time (e.g., a different application).
		var tracks = screenStream.getTracks();
		for(var mst of tracks) {
			if(mst)
				mst.stop();
		}
		screenStream = null;
		current = "webcam";
		// Let's remove the darkened area on the local video preview.
		$("#videolocal").unblock();
		// Change the screensharing icon too, to allow the speaker to
		// share their screen again, should they want to do that later.
		$('#share').html('<i class="fa fa-television"></i>')
			.attr('title', 'Share your screen')
			.removeAttr('disabled')
			.click(function() {
				$('#share').attr('disabled', true).unbind('click');
				// Let's show the screen sharing dialog
				changeVideoTo("screen");
			});
	}
}

// Helper to parse query string
function getQueryStringValue(name) {
	name = name.replace(/[\[]/, "\\[").replace(/[\]]/, "\\]");
	var regex = new RegExp("[\\?&]" + name + "=([^&#]*)"),
		results = regex.exec(location.search);
	return results === null ? "" : decodeURIComponent(results[1].replace(/\+/g, " "));
}