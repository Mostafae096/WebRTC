/* eslint-disable @typescript-eslint/no-explicit-any */
"use client";
import { useEffect, useRef, useState } from "react";
import io from "socket.io-client";
import * as mediasoupClient from "mediasoup-client";

const socket = io("https://139.162.164.202:3000/");

export default function VoiceRoom() {
  const [inCall, setInCall] = useState(false);
  const [userId, setUserId] = useState("");
  const [roomId, setRoomId] = useState("");
  const [speaking, setSpeaking] = useState(false);
  const [mute, setMute] = useState(false);
  const [blocked, setBlocked] = useState(false);
  const [remoteStreams, setRemoteStreams] = useState<
    { producerId: string; stream: MediaStream }[]
  >([]);
  const remoteAudioRef = useRef<HTMLAudioElement>(null);
  const sendTransportRef = useRef<any>(null);
  const recvTransportRef = useRef<any>(null);
  const audioTrackRef = useRef<MediaStreamTrack | null>(null);
  const audioRefs = useRef<{ [producerId: string]: HTMLAudioElement | null }>(
    {}
  );

  const startCall = async () => {
    setBlocked(false);

    const stream = await navigator.mediaDevices.getUserMedia({ audio: true });
    const audioTrack = stream.getAudioTracks()[0];
    audioTrackRef.current = audioTrack;

    // Voice Activity Detection (optional)
    const context = new AudioContext();
    const source = context.createMediaStreamSource(stream);
    const analyser = context.createAnalyser();
    source.connect(analyser);

    const detectVoice = () => {
      const data = new Uint8Array(analyser.frequencyBinCount);
      analyser.getByteFrequencyData(data);
      const volume = data.reduce((a, b) => a + b, 0) / data.length;
      setSpeaking(volume > 10);
      requestAnimationFrame(detectVoice);
    };
    detectVoice();

    const rtpCapabilities = await new Promise<any>((res) =>
      socket.emit("joinRoom", { roomId, userId }, res)
    );

    if (rtpCapabilities?.error) {
      if (rtpCapabilities.error.includes("not allowed")) {
        setBlocked(true);
        return;
      }
      alert(rtpCapabilities.error);
      return;
    }

    const device = new mediasoupClient.Device();
    await device.load({ routerRtpCapabilities: rtpCapabilities });

    // Create send transport
    const sendTransportParams = await new Promise<any>((res) =>
      socket.emit("createTransport", { roomId, direction: "send" }, res)
    );

    const sendTransport = device.createSendTransport(sendTransportParams);
    sendTransportRef.current = sendTransport;

    sendTransport.on("connectionstatechange", (state: any) => {
      console.log("Send transport state:", state);
    });

    sendTransport.on("connect", ({ dtlsParameters }, cb) => {
      socket.emit("connectTransport", {
        roomId,
        dtlsParameters,
        transportId: sendTransport.id,
      });
      cb();
    });

    sendTransport.on("produce", ({ kind, rtpParameters }, cb) => {
      socket.emit(
        "produce",
        {
          transportId: sendTransport.id,
          kind,
          rtpParameters,
          roomId,
        },
        cb
      );
    });

    await sendTransport.produce({ track: audioTrack });

    // Handle remote audio
    socket.on("newProducer", async ({ producerId }) => {
      // Prevent duplicate consumption
      if (remoteStreams.find((s) => s.producerId === producerId)) return;

      const recvTransportParams = await new Promise<any>((res) =>
        socket.emit("createTransport", { roomId, direction: "recv" }, res)
      );

      const recvTransport = device.createRecvTransport(recvTransportParams);
      recvTransportRef.current = recvTransport;

      recvTransport.on("connectionstatechange", (state: any) => {
        console.log("Recv transport state:", state);
      });

      recvTransport.on("connect", ({ dtlsParameters }, cb) => {
        socket.emit("connectTransport", {
          roomId,
          dtlsParameters,
          transportId: recvTransport.id,
        });
        cb();
      });

      const consumerParams = await new Promise<any>((res) =>
        socket.emit(
          "consume",
          {
            roomId,
            producerId,
            rtpCapabilities: device.rtpCapabilities,
          },
          res
        )
      );

      const consumer = await recvTransport.consume({
        id: consumerParams.id,
        producerId: consumerParams.producerId,
        kind: consumerParams.kind,
        rtpParameters: consumerParams.rtpParameters,
      });

      const remoteStream = new MediaStream([consumer.track]);
      sendTransport.on("connectionstatechange", (state) => {
        console.log("Send transport state:", state);
      });
      recvTransport.on("connectionstatechange", (state) => {
        console.log("Recv transport state:", state);
      });

      setRemoteStreams((prev) => [
        ...prev,
        { producerId, stream: remoteStream },
      ]);
    });

    setInCall(true);
  };

  const endCall = () => {
    // Stop local audio track
    audioTrackRef.current?.stop();

    // Close transports
    sendTransportRef.current?.close();
    recvTransportRef.current?.close();

    // Remove all socket listeners for this component
    socket.removeAllListeners("newProducer");

    // Reset state
    setInCall(false);
    setSpeaking(false);
    setRemoteStreams([]);
    if (remoteAudioRef.current) {
      remoteAudioRef.current.srcObject = null;
    }
  };

  useEffect(() => {
    // Set srcObject for each remote stream
    remoteStreams.forEach(({ producerId, stream }) => {
      const audioElem = audioRefs.current[producerId];
      if (audioElem && audioElem.srcObject !== stream) {
        audioElem.srcObject = stream;
      }
    });
  }, [remoteStreams]);

  return (
    <div style={{ padding: 20 }}>
      <h2>Group Voice Room</h2>
      {blocked && (
        <div style={{ color: "red", fontWeight: "bold", marginBottom: 10 }}>
          🚫 You are blocked from joining this room.
        </div>
      )}
      <input
        placeholder="Room ID"
        value={roomId}
        onChange={(e) => setRoomId(e.target.value)}
        style={{ padding: 10, fontSize: 16, marginRight: 10 }}
      />
      <input
        placeholder="userId"
        value={userId}
        onChange={(e) => setUserId(e.target.value)}
        style={{ padding: 10, fontSize: 16, marginRight: 10 }}
      />
      <button
        onClick={startCall}
        disabled={!roomId}
        style={{
          backgroundColor: "#0070f3",
          color: "white",
          padding: "10px 20px",
          borderRadius: 6,
          fontSize: 16,
          cursor: "pointer",
        }}
      >
        Join Call
      </button>

      {inCall && (
        <div style={{ marginTop: 20 }}>
          <p>
            You are in room: <strong>{roomId}</strong>
          </p>
          <p>
            Voice status:{" "}
            <span
              style={{
                color: speaking ? "green" : "gray",
                fontWeight: "bold",
              }}
            >
              {speaking ? "Speaking" : "Silent"}
            </span>
          </p>
          <button
            onClick={endCall}
            style={{
              backgroundColor: "#e00",
              color: "white",
              padding: "10px 20px",
              borderRadius: 6,
              fontSize: 16,
              cursor: "pointer",
              marginTop: 10,
              marginRight: 10,
            }}
          >
            End Call
          </button>
        </div>
      )}
      <button onClick={() => setMute(true)}>Mute</button>
      <button onClick={() => setMute(false)}>Unmute</button>

      {remoteStreams.map(({ producerId }) => (
        <audio
          key={producerId}
          ref={(el) => {
            audioRefs.current[producerId] = el;
          }}
          autoPlay
          muted={mute}
        />
      ))}
    </div>
  );
}
